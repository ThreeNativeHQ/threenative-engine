import {
  type Camera,
  OrthographicCamera,
  PerspectiveCamera,
  Plane,
  Raycaster,
  Vector2,
  Vector3,
} from "three";
import { hostDocument, hostWindow } from "./platform.js";
import { type IRendererLike, observeCanvasResize, readCanvasSize } from "./renderer.js";

export interface IViewportSize {
  readonly aspect: number;
  readonly height: number;
  readonly width: number;
}

export interface IViewportInsets {
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
}

export interface IViewportSafeArea extends IViewportInsets {
  /** The safe rectangle in drawable pixel coordinates, with y measured from the top edge. */
  readonly height: number;
  readonly source: "full-drawable-fallback" | "measured";
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

export interface IViewportOptions {
  readonly camera: Camera;
  readonly renderer: IRendererLike;
  readonly source?: IViewportPlatformSource;
}

export type ViewportResizeHandler = (size: IViewportSize) => void;

export interface IViewportPlatformSource {
  observeResize(canvas: HTMLCanvasElement, resize: () => void): () => void;
  readSize(canvas: HTMLCanvasElement): IViewportSize;
  readSafeArea?(canvas: HTMLCanvasElement, size: IViewportSize): IViewportInsets | undefined;
}

export class Viewport {
  readonly camera: Camera;
  readonly renderer: IRendererLike;
  #source: IViewportPlatformSource | undefined;
  #listeners = new Set<ViewportResizeHandler>();
  #size: IViewportSize = { aspect: 1, height: 1, width: 1 };
  #safeArea: IViewportSafeArea = fullDrawableSafeArea(this.#size);
  #stopObserving: () => void = () => undefined;
  #disposed = false;
  #raycaster = new Raycaster();
  #ndc = new Vector2();
  #plane = new Plane(new Vector3(0, 0, 1));
  #projected = new Vector3();
  #unprojected = new Vector3();

  constructor(options: IViewportOptions) {
    this.camera = options.camera;
    this.renderer = options.renderer;
    this.#source = options.source;
    this.#stopObserving =
      this.#source?.observeResize(this.renderer.domElement, this.#resize) ??
      observeCanvasResize(this.renderer.domElement, this.#resize);
    this.resize();
  }

  get size(): IViewportSize {
    return this.#size;
  }

  get safeArea(): IViewportSafeArea {
    return this.#safeArea;
  }

  projectPosition(screen: Vector2, z = 0, target?: Vector3): Vector3 {
    if (!Number.isFinite(z)) throw new Error("Viewport.projectPosition z must be finite.");
    this.#ndc.set((screen.x / this.#size.width) * 2 - 1, -((screen.y / this.#size.height) * 2 - 1));
    this.#raycaster.setFromCamera(this.#ndc, this.camera);
    this.#plane.constant = -z;
    const point = this.#raycaster.ray.intersectPlane(this.#plane, this.#projected);
    if (point === null)
      throw new Error("Viewport.projectPosition cannot reach the requested z plane.");
    return target?.copy(point) ?? point.clone();
  }

  unprojectPosition(world: Vector3, target?: Vector2): Vector2 {
    this.#unprojected.copy(world).project(this.camera);
    const result = target ?? new Vector2();
    return result.set(
      ((this.#unprojected.x + 1) / 2) * this.#size.width,
      ((1 - this.#unprojected.y) / 2) * this.#size.height,
    );
  }

  onResize(handler: ViewportResizeHandler): () => void {
    if (this.#disposed) return () => undefined;
    this.#listeners.add(handler);
    return () => this.#listeners.delete(handler);
  }

  resize(): void {
    if (this.#disposed) return;
    let next = this.#source?.readSize(this.renderer.domElement);
    if (next === undefined) {
      const [width, height] = readCanvasSize(this.renderer.domElement);
      next = { aspect: width / height, height, width };
    }
    const safeArea = readSafeArea(this.#source, this.renderer.domElement, next);
    const changed =
      next.width !== this.#size.width ||
      next.height !== this.#size.height ||
      next.aspect !== this.#size.aspect;
    const safeAreaChanged = !sameSafeArea(safeArea, this.#safeArea);
    this.#size = next;
    this.#safeArea = safeArea;
    if (this.camera instanceof PerspectiveCamera) {
      this.camera.aspect = next.aspect;
      this.camera.updateProjectionMatrix();
    } else if (this.camera instanceof OrthographicCamera) {
      const size = (this.camera.top - this.camera.bottom) / 2;
      this.camera.left = -size * next.aspect;
      this.camera.right = size * next.aspect;
      this.camera.top = size;
      this.camera.bottom = -size;
      this.camera.updateProjectionMatrix();
    }
    if (changed || safeAreaChanged) for (const listener of this.#listeners) listener(next);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#stopObserving();
    this.#stopObserving = () => undefined;
    this.#listeners.clear();
  }

  #resize = (): void => this.resize();
}

function fullDrawableSafeArea(size: IViewportSize): IViewportSafeArea {
  return {
    bottom: 0,
    height: size.height,
    left: 0,
    right: 0,
    source: "full-drawable-fallback",
    top: 0,
    width: size.width,
    x: 0,
    y: 0,
  };
}

function clampInset(value: number, maximum: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(maximum, value)) : 0;
}

function safeAreaFromInsets(size: IViewportSize, raw: IViewportInsets): IViewportSafeArea {
  const top = clampInset(raw.top, size.height);
  const bottom = clampInset(raw.bottom, size.height - top);
  const left = clampInset(raw.left, size.width);
  const right = clampInset(raw.right, size.width - left);
  return {
    bottom,
    height: Math.max(0, size.height - top - bottom),
    left,
    right,
    source: "measured",
    top,
    width: Math.max(0, size.width - left - right),
    x: left,
    y: top,
  };
}

function nativeInsets(): IViewportInsets | undefined {
  // biome-ignore lint/style/useNamingConvention: this is the native host's public global contract.
  const host = (globalThis as { __THREENATIVE_NATIVE__?: unknown }).__THREENATIVE_NATIVE__;
  if (typeof host !== "object" || host === null) return undefined;
  const value = (host as { safeAreaInsets?: unknown }).safeAreaInsets;
  if (typeof value !== "object" || value === null) return undefined;
  const insets = value as Partial<IViewportInsets>;
  if (
    typeof insets.top !== "number" ||
    typeof insets.right !== "number" ||
    typeof insets.bottom !== "number" ||
    typeof insets.left !== "number"
  )
    return undefined;
  return insets as IViewportInsets;
}

function browserInsets(): IViewportInsets | undefined {
  const page = hostDocument();
  const view = hostWindow();
  if (page === undefined || view === undefined) return undefined;
  if (typeof view.getComputedStyle !== "function") return undefined;
  const probe = page.createElement("div");
  probe.style.cssText = [
    "position:fixed",
    "inset:0",
    "padding-top:env(safe-area-inset-top)",
    "padding-right:env(safe-area-inset-right)",
    "padding-bottom:env(safe-area-inset-bottom)",
    "padding-left:env(safe-area-inset-left)",
    "visibility:hidden",
    "pointer-events:none",
  ].join(";");
  // Nothing is measured until the probe is in the document. A detached element resolves every
  // computed padding to the empty string, which parses to zero — four zeroes indistinguishable
  // from a device that genuinely has no insets, reported as `measured`. The full-drawable
  // fallback is the honest answer when there was no measurement to take.
  const body = page.body;
  if (body === null || body === undefined) return undefined;
  body.appendChild(probe);
  const style = view.getComputedStyle(probe);
  const value = {
    bottom: Number.parseFloat(style.paddingBottom) || 0,
    left: Number.parseFloat(style.paddingLeft) || 0,
    right: Number.parseFloat(style.paddingRight) || 0,
    top: Number.parseFloat(style.paddingTop) || 0,
  };
  probe.remove();
  return value;
}

function readSafeArea(
  source: IViewportPlatformSource | undefined,
  canvas: HTMLCanvasElement,
  size: IViewportSize,
): IViewportSafeArea {
  const measured = source?.readSafeArea?.(canvas, size) ?? nativeInsets() ?? browserInsets();
  return measured === undefined ? fullDrawableSafeArea(size) : safeAreaFromInsets(size, measured);
}

function sameSafeArea(left: IViewportSafeArea, right: IViewportSafeArea): boolean {
  return (
    left.bottom === right.bottom &&
    left.height === right.height &&
    left.left === right.left &&
    left.right === right.right &&
    left.source === right.source &&
    left.top === right.top &&
    left.width === right.width &&
    left.x === right.x &&
    left.y === right.y
  );
}
