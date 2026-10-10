/** three's WebGPURenderer over the Perry native player: one engine render per frame, no DOM. */
import { engineRef } from "./browser-backend.js";

interface ISetTarget<T> {
  set(x: number, y: number): T;
}
export interface IPerryRenderHost {
  readonly color: new (color: unknown) => { r: number; g: number; b: number };
  /** Flush the facade's pending engine work (collect, TSL) before a render. */
  sync(): void;
  renderInfo(): { drawCalls: number; triangles: number };
  adapterInfo(): string;
  render(
    scene: NonNullable<ReturnType<typeof engineRef>>,
    camera: NonNullable<ReturnType<typeof engineRef>>,
    width: number,
    height: number,
    tone: number,
    exposure: number,
    srgb: boolean,
    clear: readonly [number, number, number, number],
  ): void;
}

export function definePerryRenderer(host: IPerryRenderHost) {
  return class WebGPURenderer {
    readonly isWebGPURenderer = true;
    readonly domElement: HTMLCanvasElement;
    readonly shadowMap = { enabled: false, type: 1 };
    readonly backend = {
      gpu: {
        requestAdapter: async () => {
          const info = JSON.parse(host.adapterInfo());
          return info === null ? null : { info, limits: {} };
        },
      },
    };
    readonly info = {
      render: {
        get drawCalls() {
          return host.renderInfo().drawCalls;
        },
        get calls() {
          return host.renderInfo().drawCalls;
        },
        get triangles() {
          return host.renderInfo().triangles;
        },
      },
      compute: {},
      frame: 0,
      reset() {},
    };
    constructor(options: { canvas?: HTMLCanvasElement } = {}) {
      this.domElement =
        options.canvas ?? ({ width: 300, height: 150, style: {} } as HTMLCanvasElement);
    }
    autoClear = true;
    toneMapping = 0;
    toneMappingExposure = 1;
    outputColorSpace = "srgb";
    private width = 300;
    private height = 150;
    private pixelRatio = 1;
    private disposed = false;
    private clear: [number, number, number, number] = [0, 0, 0, 1];
    setClearColor(color: unknown, alpha = 1): void {
      const value = (
        typeof color === "object" && color !== null ? color : new host.color(color)
      ) as { r: number; g: number; b: number };
      if (![value.r, value.g, value.b, alpha].every(Number.isFinite))
        throw new TypeError("TN_PERRY_RENDER_CLEAR_COLOR");
      this.clear = [value.r, value.g, value.b, alpha];
    }
    getClearAlpha(): number {
      return this.clear[3];
    }
    setClearAlpha(alpha: number): void {
      if (!Number.isFinite(alpha)) throw new TypeError("TN_PERRY_RENDER_CLEAR_ALPHA");
      this.clear[3] = alpha;
    }
    setSize(width: number, height: number): void {
      if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0)
        throw new RangeError("TN_PERRY_RENDER_SIZE");
      this.width = width;
      this.height = height;
    }
    getSize<T extends ISetTarget<T>>(target: T): T {
      return target.set(this.width, this.height);
    }
    setPixelRatio(ratio = 1): void {
      if (!Number.isFinite(ratio) || ratio <= 0)
        throw new RangeError("TN_PERRY_RENDER_PIXEL_RATIO");
      this.pixelRatio = ratio;
    }
    getPixelRatio(): number {
      return this.pixelRatio;
    }
    getDrawingBufferSize<T extends ISetTarget<T>>(target: T): T {
      const [width, height] = this.drawSize();
      return target.set(width, height);
    }
    /** WebGPUCapabilities.getMaxAnisotropy, as on the V8 player: WebGPU samplers clamp to 16. */
    getMaxAnisotropy(): number {
      return 16;
    }
    getRenderTarget(): null {
      return null;
    }
    setRenderTarget(target: unknown): void {
      if (target !== null) throw new Error("TN_PERRY_RENDER_TARGET: render targets are not wired");
    }
    async init(): Promise<this> {
      if (this.disposed) throw new Error("TN_PERRY_RENDER_DISPOSED");
      return this;
    }
    render(scene: unknown, camera: unknown): void {
      if (this.disposed) throw new Error("TN_PERRY_RENDER_DISPOSED");
      if (this.outputColorSpace !== "srgb" && this.outputColorSpace !== "srgb-linear")
        throw new TypeError("TN_PERRY_RENDER_COLOR_SPACE");
      if (
        typeof scene !== "object" ||
        scene === null ||
        typeof camera !== "object" ||
        camera === null
      )
        throw new TypeError("TN_PERRY_RENDER_ARGUMENT");
      const sceneRef = engineRef(scene);
      const cameraRef = engineRef(camera);
      if (sceneRef === undefined || cameraRef === undefined)
        throw new TypeError("TN_PERRY_RENDER_ARGUMENT");
      host.sync();
      const [width, height] = this.drawSize();
      host.render(
        sceneRef,
        cameraRef,
        width,
        height,
        this.toneMapping,
        this.toneMappingExposure,
        this.outputColorSpace === "srgb",
        this.clear,
      );
    }
    dispose(): void {
      this.disposed = true;
    }
    private drawSize(): [number, number] {
      return [
        Math.max(1, Math.floor(this.width * this.pixelRatio)),
        Math.max(1, Math.floor(this.height * this.pixelRatio)),
      ];
    }
  };
}
