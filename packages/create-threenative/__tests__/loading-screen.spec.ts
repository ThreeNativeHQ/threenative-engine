import { cp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  Scene,
  Texture,
} from "three";
import { describe, expect, it, vi } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import {
  canonicalLoadingPath,
  createProject,
  discoverStampedTemplates,
  restampTemplateLoadingCopies,
  stampLoadingSource,
} from "../src/index.js";
import {
  loading as actionLoading,
  createLoadingScreen as createActionLoadingScreen,
} from "../templates/action-rpg/src/render/loading.js";
import { createLoadingScreen, loading } from "../templates/platformer/src/render/loading.js";
import {
  createLoadingScreen as createRacingLoadingScreen,
  loading as racingLoading,
} from "../templates/racing/src/render/loading.js";
import {
  createLoadingScreen as createSailingLoadingScreen,
  loading as sailingLoading,
} from "../templates/sailing/src/render/loading.js";
import {
  createLoadingScreen as createShooterLoadingScreen,
  loading as shooterLoading,
} from "../templates/shooter/src/render/loading.js";
import {
  createLoadingScreen as createStarterLoadingScreen,
  loading as starterLoading,
} from "../templates/starter/src/render/loading.js";
import {
  createLoadingScreen as createDefenseLoadingScreen,
  loading as defenseLoading,
} from "../templates/tower-defense/src/render/loading.js";

const templateRoot = path.resolve("packages/create-threenative/templates");
type LoadingWarmup = { readonly status: "complete" | "incomplete" | "unavailable" };
// Read off disk, so a kit added tomorrow is covered by this suite the day it ships its
// appearance block rather than the day somebody remembers to extend a list here.
const stampedTemplates = discoverStampedTemplates(templateRoot);
const loadingPath = (template: string): string =>
  path.join(templateRoot, template, "src/render/loading.ts");

/**
 * The loading screen is generated user source, but every scaffolded project starts from this copy,
 * so a defect here ships to every game that keeps the default loading screen.
 */
function host(
  width = 900,
  height = 900,
  safeArea?: { height: number; width: number; x: number; y: number },
) {
  const camera = new PerspectiveCamera(60, width / height, 0.1, 2_000);
  const scene = new Scene();
  scene.add(camera);
  const canvasCamera = new OrthographicCamera(-width / 2, width / 2, height / 2, -height / 2, 0, 2);
  canvasCamera.position.z = 1;
  return {
    assets: undefined as { texture(path: string): Promise<Texture> } | undefined,
    camera,
    canvasLayer: { camera: canvasCamera, opaque: false, scene: new Scene() },
    scene,
    // Neither promise resolves: the screen must be correct while it is still up, which is the point.
    renderer: { compileAsync: () => new Promise<void>(() => undefined) },
    startup: {
      progress: 0,
      warmup: undefined as LoadingWarmup | undefined,
      whenReady: () => new Promise<void>(() => undefined),
    },
    ...(safeArea === undefined ? {} : { viewport: { safeArea } }),
  };
}

function setLoadingValue<K extends keyof typeof loading>(key: K, value: unknown): void {
  Object.defineProperty(loading, key, { configurable: true, value, writable: true });
}

/** The three quads, in the order the screen adds them: backdrop, track, fill. */
function quads(scene: Scene): { backdrop: Mesh; track: Mesh; fill: Mesh } {
  const meshes = scene.children.filter((child): child is Mesh => (child as Mesh).isMesh === true);
  if (meshes.length !== 3) throw new Error(`expected 3 loading quads, found ${meshes.length}`);
  const [backdrop, track, fill] = meshes as [Mesh, Mesh, Mesh];
  return { backdrop, track, fill };
}

function resizeCanvas(camera: OrthographicCamera, width: number, height: number): void {
  camera.left = -width / 2;
  camera.right = width / 2;
  camera.top = height / 2;
  camera.bottom = -height / 2;
  camera.updateProjectionMatrix();
}

describe("template loading screen", () => {
  it("requires every full kit to ship the loading source", async () => {
    for (const template of stampedTemplates) {
      await expect(readFile(loadingPath(template), "utf8"), template).resolves.toContain(
        "export function createLoadingScreen",
      );
    }
  });

  it("keeps every full kit stamped from the one canonical implementation", async () => {
    const canonicalPath = canonicalLoadingPath(templateRoot);
    const canonical = await readFile(canonicalPath, "utf8");
    expect(canonicalPath).toContain("template-assets/loading.ts");
    expect(canonical).toContain("BEGIN THREENATIVE LOADING APPEARANCE");

    for (const template of stampedTemplates) {
      const source = await readFile(loadingPath(template), "utf8");
      expect(stampLoadingSource(canonical, source), template).toBe(source);
      expect(source, template).not.toMatch(/@threenative\//u);
      expect(source, template).not.toMatch(/function createStatus|const create\s*=/u);
      expect(source.match(/export function createLoadingScreen/gu), template).toHaveLength(1);
      expect(source.match(/function meshFor/gu), template).toHaveLength(1);
      expect(source.match(/function statusMesh/gu), template).toHaveLength(1);
    }
  });

  it("restamps a canonical structural edit while retaining each kit's appearance block", async () => {
    const canonical = await readFile(canonicalLoadingPath(templateRoot), "utf8");
    const source = await readFile(loadingPath("platformer"), "utf8");
    const edited = canonical.replace("function meshFor(", "function canonicalMeshFor(");

    expect(stampLoadingSource(edited, source)).toContain("function canonicalMeshFor(");
    expect(stampLoadingSource(edited, source)).toContain("maxWidth: 1200");
  });

  it("restamps all seven tracked copies from a canonical edit", async () => {
    const root = await makeTempDir("threenative-loading-restamp-");
    const stagedTemplates = path.join(root, "templates");
    await cp(templateRoot, stagedTemplates, { recursive: true });
    await cp(path.join(templateRoot, "../template-assets"), path.join(root, "template-assets"), {
      recursive: true,
    });

    const canonicalPath = path.join(root, "template-assets", "loading.ts");
    const canonical = await readFile(canonicalPath, "utf8");
    const mutation = "function restampReviewRoundMeshFor(";
    await writeFile(canonicalPath, canonical.replace("function meshFor(", mutation));
    const originalSources = new Map(
      await Promise.all(
        stampedTemplates.map(
          async (template) =>
            [
              template,
              await readFile(loadingPath(template).replace(templateRoot, stagedTemplates), "utf8"),
            ] as const,
        ),
      ),
    );

    const files = await restampTemplateLoadingCopies(stagedTemplates);
    expect(files).toHaveLength(stampedTemplates.length);
    for (const template of stampedTemplates) {
      const source = await readFile(
        loadingPath(template).replace(templateRoot, stagedTemplates),
        "utf8",
      );
      expect(source, template).toContain(mutation);
      expect(source, template).toContain("BEGIN THREENATIVE LOADING APPEARANCE");
      expect(source, template).toBe(
        stampLoadingSource(
          canonical.replace("function meshFor(", mutation),
          originalSources.get(template) ?? "",
        ),
      );
    }
  });

  it("propagates a canonical edit through createProject while retaining the kit appearance", async () => {
    const root = await makeTempDir("threenative-loading-scaffold-");
    const stagedTemplates = path.join(root, "templates");
    await cp(templateRoot, stagedTemplates, { recursive: true });
    await cp(path.join(templateRoot, "..", "template-assets"), path.join(root, "template-assets"), {
      recursive: true,
    });
    // `agent-files` became a required scaffold input; a staged package without it fails
    // TN_AGENT_FILES_MISSING, which is the scaffolder correctly refusing to generate a project
    // with no agent roles rather than this test finding a real defect.
    await cp(path.join(templateRoot, "..", "agent-files"), path.join(root, "agent-files"), {
      recursive: true,
    });
    await cp(path.join(templateRoot, "..", "agent-docs"), path.join(root, "agent-docs"), {
      recursive: true,
    });
    // The authoring stamp records the package version (PRD-829).
    await cp(path.join(templateRoot, "..", "package.json"), path.join(root, "package.json"));

    const canonicalPath = path.join(root, "template-assets", "loading.ts");
    const canonical = await readFile(canonicalPath, "utf8");
    const mutation = "function canonicalReviewRoundMeshFor(";
    await writeFile(canonicalPath, canonical.replace("function meshFor(", mutation));

    const templateSource = await readFile(loadingPath("platformer"), "utf8");
    const appearance = templateSource.match(
      /\/\* BEGIN THREENATIVE LOADING APPEARANCE \*\/[\s\S]*?\/\* END THREENATIVE LOADING APPEARANCE \*\//u,
    )?.[0];
    expect(appearance).toBeDefined();

    const { target } = await createProject(
      { install: false, target: "generated", template: "platformer" },
      root,
      stagedTemplates,
    );
    const generated = await readFile(path.join(target, "src/render/loading.ts"), "utf8");
    expect(generated).toContain(mutation);
    expect(generated).toContain(appearance as string);
  });

  it("draws opaque quads only in the independent canvas layer", () => {
    const source = host();
    const worldChildren = [...source.scene.children];
    createLoadingScreen(source);
    const { backdrop, track, fill } = quads(source.canvasLayer.scene);

    expect(source.canvasLayer.opaque).toBe(true);
    expect(source.scene.children).toEqual(worldChildren);
    expect(source.canvasLayer.camera.children).toEqual([]);
    for (const quad of [backdrop, track, fill]) {
      expect(quad.parent).toBe(source.canvasLayer.scene);
      expect(quad.material).toBeInstanceOf(MeshBasicMaterial);
      expect((quad.material as MeshBasicMaterial).transparent).toBe(false);
      expect(quad.renderOrder).toBeLessThanOrEqual(1_000);
    }
  });

  it("can disable the overlay without creating meshes or blocking the world", () => {
    const source = host();
    const previous: boolean = loading.enabled;
    setLoadingValue("enabled", false);
    try {
      const controller = createLoadingScreen(source);
      expect(source.canvasLayer.scene.children).toEqual([]);
      expect(source.canvasLayer.opaque).toBe(false);
      controller.update();
      controller.finish();
    } finally {
      setLoadingValue("enabled", previous);
    }
  });

  it("sizes the progress fill before the first frame, not on the first update", () => {
    const source = host();
    createLoadingScreen(source);
    const { track, fill } = quads(source.canvasLayer.scene);

    expect(fill.scale.x).not.toBe(1);
    expect(fill.scale.y).not.toBe(1);
    expect(fill.scale.y).toBeCloseTo(track.scale.y, 6);
    expect(fill.scale.x).toBeLessThan(track.scale.x);
  });

  it("preserves each kit's zero-progress minimum fill appearance", () => {
    const kits = [
      [actionLoading, createActionLoadingScreen, 1],
      [defenseLoading, createDefenseLoadingScreen, 1],
      [loading, createLoadingScreen, 2],
      [racingLoading, createRacingLoadingScreen, 1],
      [sailingLoading, createSailingLoadingScreen, 1],
      [shooterLoading, createShooterLoadingScreen, 1],
      [starterLoading, createStarterLoadingScreen, 1],
    ] as const;

    for (const [configuration, create, minimum] of kits) {
      const source = host();
      create(source);
      const { fill } = quads(source.canvasLayer.scene);
      expect(configuration.bar.minWidth).toBe(minimum);
      expect(fill.scale.x).toBe(minimum);
    }
  });

  it("never lets the fill outgrow the track, whatever progress reports", () => {
    const source = host();
    const loading = createLoadingScreen(source);
    const { track, fill } = quads(source.canvasLayer.scene);

    for (const progress of [0, 0.25, 0.5, 1, 2, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      source.startup.progress = progress;
      loading.update();
      expect(fill.scale.y).toBeCloseTo(track.scale.y, 6);
      expect(fill.scale.x).toBeLessThanOrEqual(track.scale.x + 1e-9);
      expect(Number.isFinite(fill.scale.x)).toBe(true);
      expect(Number.isFinite(fill.position.x)).toBe(true);
    }
  });

  it("does not show complete progress when warm-up coverage is unknown", () => {
    const source = host();
    source.startup.warmup = { status: "incomplete" };
    const controller = createLoadingScreen(source);
    const { track, fill } = quads(source.canvasLayer.scene);

    source.startup.progress = 1;
    controller.update();

    expect(fill.scale.x).toBeLessThan(track.scale.x);
    controller.finish();
  });

  it.each([
    ["portrait", 1080, 2400],
    ["landscape", 2400, 1080],
    ["square", 1080, 1080],
  ])("keeps the bar inside the pixel-sized viewport in %s", (_name, width, height) => {
    const source = host(width, height);
    const loading = createLoadingScreen(source);
    const { backdrop, track, fill } = quads(source.canvasLayer.scene);

    expect(track.scale.x).toBeLessThanOrEqual(width);
    expect(backdrop.scale.x).toBe(width);
    expect(backdrop.scale.y).toBe(height);

    for (const progress of [0, 0.5, 1]) {
      source.startup.progress = progress;
      loading.update();
      const left = fill.position.x - fill.scale.x / 2;
      const right = fill.position.x + fill.scale.x / 2;
      expect(left).toBeGreaterThanOrEqual(-track.scale.x / 2 - 1e-9);
      expect(right).toBeLessThanOrEqual(track.scale.x / 2 + 1e-9);
    }
  });

  it("relays out when the device rotates mid-load", () => {
    const source = host(2400, 1080);
    const loading = createLoadingScreen(source);
    const { backdrop, track } = quads(source.canvasLayer.scene);
    const landscapeTrack = track.scale.x;

    resizeCanvas(source.canvasLayer.camera, 1080, 2400);
    source.startup.progress = 0.5;
    loading.update();

    expect(track.scale.x).toBeLessThan(landscapeTrack);
    expect(backdrop.scale.x).toBe(1080);
    expect(backdrop.scale.y).toBe(2400);
  });

  it("keeps the bar inside an asymmetric measured safe rectangle", () => {
    const source = host(900, 600, { height: 500, width: 740, x: 64, y: 72 });
    createLoadingScreen(source);
    const { track, fill } = quads(source.canvasLayer.scene);
    const camera = source.canvasLayer.camera;
    const safeLeft = camera.left + 64;
    const safeRight = camera.right - 96;
    const safeTop = camera.top - 72;
    const safeBottom = camera.bottom + 28;
    expect(track.position.x - track.scale.x / 2).toBeGreaterThanOrEqual(safeLeft - 1e-9);
    expect(track.position.x + track.scale.x / 2).toBeLessThanOrEqual(safeRight + 1e-9);
    expect(track.position.y + track.scale.y / 2).toBeLessThanOrEqual(safeTop + 1e-9);
    expect(track.position.y - track.scale.y / 2).toBeGreaterThanOrEqual(safeBottom - 1e-9);
    expect(fill.position.x - fill.scale.x / 2).toBeGreaterThanOrEqual(safeLeft - 1e-9);
  });

  it("crops image fills and covers image backdrops without stretching", async () => {
    const source = host(900, 900);
    const background = new Texture({ width: 1800, height: 900 });
    const fillImage = new Texture({ width: 900, height: 1800 });
    const previousBackground = loading.backgroundImage;
    const previousFill = loading.fillImage;
    setLoadingValue("backgroundImage", "background.png");
    setLoadingValue("fillImage", "fill.png");
    source.assets = {
      texture: vi.fn(async (path: string) => (path === "background.png" ? background : fillImage)),
    };
    try {
      const controller = createLoadingScreen(source);
      await Promise.resolve();
      const { backdrop, fill } = quads(source.canvasLayer.scene);
      const backdropUv = backdrop.geometry.getAttribute("uv");
      expect(backdropUv.getX(0)).toBeCloseTo(0.25, 6);
      expect(backdropUv.getX(1)).toBeCloseTo(0.75, 6);
      source.startup.progress = 0.5;
      controller.update();
      const fillUv = fill.geometry.getAttribute("uv");
      expect(fillUv.getX(0)).toBeCloseTo(0, 6);
      expect(fillUv.getX(1)).toBeCloseTo(0.5, 6);
      controller.finish();
    } finally {
      setLoadingValue("backgroundImage", previousBackground);
      setLoadingValue("fillImage", previousFill);
      background.dispose();
      fillImage.dispose();
    }
  });

  it("removes and disposes its quads before making the canvas layer transparent", () => {
    const source = host();
    const loading = createLoadingScreen(source);
    const parts = Object.values(quads(source.canvasLayer.scene));
    const disposals = parts.flatMap((mesh) => [
      vi.spyOn(mesh.geometry, "dispose"),
      vi.spyOn(mesh.material as MeshBasicMaterial, "dispose"),
    ]);

    loading.finish();

    expect(source.canvasLayer.scene.children).toEqual([]);
    expect(source.canvasLayer.opaque).toBe(false);
    for (const dispose of disposals) expect(dispose).toHaveBeenCalledOnce();
  });

  it("waits for core readiness, then reveals without waiting on the unawaited prewarm", async () => {
    let ready: () => void = () => undefined;
    const readyPromise = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const source = host();
    source.startup.whenReady = () => readyPromise;
    // The prewarm's promise never settles here, which is the point: the reveal must not wait on it.
    const compileAsync = vi.fn(() => new Promise<void>(() => undefined));
    source.renderer.compileAsync = compileAsync;
    createLoadingScreen(source);

    expect(source.canvasLayer.opaque).toBe(true);
    expect(source.canvasLayer.scene.children).toHaveLength(3);

    ready();
    await readyPromise;
    await Promise.resolve();
    expect(source.renderer.compileAsync).toHaveBeenCalledOnce();
    expect(compileAsync.mock.calls[0]).toEqual([source.scene, source.camera]);
    expect(source.canvasLayer.scene.children).toEqual([]);
    expect(source.canvasLayer.opaque).toBe(false);
  });

  it("does not leave a one-frame screen when startup and compilation are already settled", async () => {
    const source = host();
    source.startup.whenReady = () => Promise.resolve();
    source.renderer.compileAsync = vi.fn(() => Promise.resolve());

    createLoadingScreen(source);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Startup and compilation are both settled, and the screen still fires its one prewarm —
    // now harmless, because the reveal never waits on it.
    expect(source.renderer.compileAsync).toHaveBeenCalledOnce();
    expect(source.canvasLayer.scene.children).toEqual([]);
    expect(source.canvasLayer.opaque).toBe(false);
  });

  it("keeps the screen up while startup has not settled, on no timer at all", async () => {
    vi.useFakeTimers();
    try {
      const source = host();
      source.startup.whenReady = () => new Promise<void>(() => undefined);
      source.renderer.compileAsync = vi.fn(() => Promise.resolve());

      createLoadingScreen(source);
      await Promise.resolve();
      await Promise.resolve();
      expect(source.canvasLayer.opaque).toBe(true);

      // No wall-clock ceiling reveals the world behind a startup that never finished. `whenReady()`
      // is the only gate, so a game that really is still collapsing keeps its launch screen.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(source.canvasLayer.scene.children).toHaveLength(3);
      expect(source.canvasLayer.opaque).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reveals even when the renderer has no compileAsync to prewarm with", async () => {
    const source = host();
    source.startup.whenReady = () => Promise.resolve();
    (source.renderer as { compileAsync?: unknown }).compileAsync = undefined;

    createLoadingScreen(source);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(source.canvasLayer.scene.children).toEqual([]);
    expect(source.canvasLayer.opaque).toBe(false);
  });
});
