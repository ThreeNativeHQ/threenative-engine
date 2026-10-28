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
import { palette } from "./palette.js";

/* BEGIN THREENATIVE LOADING APPEARANCE */
/** The five authoring points for this screen stay in this generated file. */
export const loading = {
  backgroundColor: palette.skyLow,
  backgroundImage: undefined as string | undefined,
  enabled: true,
  fillImage: undefined as string | undefined,
  logoImage: undefined as string | undefined,
  progressColor: palette.accent,
  showStatus: false,
  trackColor: palette.skyHigh,
  bar: {
    anchorX: 0.5,
    anchorY: 0.72,
    height: 12,
    maxWidth: 1200,
    minWidth: 2,
    width: 0.62,
  },
} as const;
/* END THREENATIVE LOADING APPEARANCE */

interface ILoadingHost {
  readonly assets?: { texture(path: string): Promise<Texture> };
  readonly camera: Camera;
  readonly canvasLayer: {
    readonly camera: OrthographicCamera;
    readonly scene: Scene;
    opaque: boolean;
  };
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

function statusMesh(
  layer: ILoadingHost["canvasLayer"],
):
  | { mesh: Mesh<PlaneGeometry, MeshBasicMaterial>; texture: Texture; update(value: number): void }
  | undefined {
  if (!loading.showStatus || typeof document === "undefined") return undefined;
  const canvas = document.createElement("canvas");
  canvas.width = 180;
  canvas.height = 48;
  const context = canvas.getContext("2d");
  if (context === null) return undefined;
  const texture = new CanvasTexture(canvas);
  const mesh = meshFor(
    layer,
    new MeshBasicMaterial({ depthTest: false, depthWrite: false, map: texture, transparent: true }),
    4,
  );
  const update = (value: number): void => {
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#ffffff";
    context.font = "700 20px monospace";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(`${Math.round(value * 100)}%`, canvas.width / 2, canvas.height / 2);
    texture.needsUpdate = true;
  };
  update(0);
  return { mesh, texture, update };
}

export function createLoadingScreen(host: ILoadingHost): ILoadingController {
  const layer = host.canvasLayer;
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
  };

  void (async () => {
    await host.startup.whenReady();
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
      if (!done) updateProgress(host.startup.progress);
    },
  };
}
