import {
  BackSide,
  type Camera,
  CubeCamera,
  HalfFloatType,
  Mesh,
  NoToneMapping,
  type RenderTarget,
  Scene,
  SphereGeometry,
  type Texture,
  type Vector3,
} from "three";
import {
  CubeRenderTarget,
  MeshBasicNodeMaterial,
  type Node,
  PMREMGenerator,
  type WebGPURenderer,
} from "three/webgpu";

export interface ISkyCaptureOptions {
  /** Power of two, at least 16. Defaults to 128 texels per face. */
  readonly resolution?: number;
  /** Radians, in [0, PI]. Defaults to one degree; equality does not refresh. */
  readonly thresholdAngle?: number;
  /** Integer in [1, 6]. Defaults to one (six frames per capture). */
  readonly facesPerFrame?: number;
  readonly lowerHemisphereBlack?: boolean;
}

/** GPU-free sun movement and cube-face budget. An in-flight capture always finishes. */
export class SkyCaptureSchedule {
  readonly #threshold: number;
  readonly #budget: number;
  #sun: Vector3 | undefined;
  #face = 6;

  constructor(options: Pick<ISkyCaptureOptions, "thresholdAngle" | "facesPerFrame"> = {}) {
    this.#threshold = options.thresholdAngle ?? Math.PI / 180;
    this.#budget = options.facesPerFrame ?? 1;
    if (!Number.isFinite(this.#threshold) || this.#threshold < 0 || this.#threshold > Math.PI) {
      throw new Error("SkyCapture.thresholdAngle must be radians in [0, PI].");
    }
    if (!Number.isInteger(this.#budget) || this.#budget < 1 || this.#budget > 6) {
      throw new Error("SkyCapture.facesPerFrame must be an integer in [1, 6].");
    }
  }

  next(sunDirection: Vector3): number[] {
    const length = Math.hypot(sunDirection.x, sunDirection.y, sunDirection.z);
    if (!Number.isFinite(length) || length === 0) {
      throw new Error("SkyCapture sun direction must be finite and nonzero.");
    }
    const sun = sunDirection.clone().divideScalar(length);
    if (this.#face === 6) {
      if (this.#sun !== undefined && this.#sun.angleTo(sun) <= this.#threshold) return [];
      this.#sun = sun;
      this.#face = 0;
    }
    const start = this.#face;
    this.#face = Math.min(6, start + this.#budget);
    return Array.from({ length: this.#face - start }, (_, i) => start + i);
  }

  /** Retry the entire capture after a render or filter failure. */
  reset(): void {
    this.#sun = undefined;
    this.#face = 6;
  }
}

/** Capture game-owned radiance and prefilter it with Three.js WebGPU PMREM.
 * @situation light a scene from a procedural sky when its sun moves
 * @constraint call update once per frame on an initialized WebGPURenderer; assign texture after it returns true
 * @constraint sky nodes use a world-space view direction; keep supplied sky resources alive until dispose
 * @example const capture = new SkyCapture(renderer, skyNode); if (capture.update(sun)) scene.environment = capture.texture;
 */
export class SkyCapture {
  readonly cubeTarget: CubeRenderTarget;
  readonly #renderer: WebGPURenderer;
  readonly #scene: Scene;
  readonly #camera: CubeCamera;
  readonly #schedule: SkyCaptureSchedule;
  readonly #mask: Scene | undefined;
  readonly #maskMesh: Mesh<SphereGeometry, MeshBasicNodeMaterial> | undefined;
  #pmrem: PMREMGenerator | undefined;
  #filtered: RenderTarget | undefined;
  #disposed = false;

  constructor(
    renderer: WebGPURenderer,
    sky: Scene | Node<"vec3">,
    options: ISkyCaptureOptions = {},
  ) {
    this.#schedule = new SkyCaptureSchedule(options);
    const size = options.resolution ?? 128;
    if (!Number.isSafeInteger(size) || size < 16 || !Number.isInteger(Math.log2(size))) {
      throw new Error("SkyCapture.resolution must be a power of two >= 16.");
    }
    if (
      options.lowerHemisphereBlack !== undefined &&
      typeof options.lowerHemisphereBlack !== "boolean"
    ) {
      throw new Error("SkyCapture.lowerHemisphereBlack must be boolean.");
    }
    if (!(sky instanceof Scene) && sky?.isNode !== true)
      throw new Error("SkyCapture requires a Scene or sky node.");
    this.#renderer = renderer;
    this.#scene = sky instanceof Scene ? sky : new Scene();
    if (!(sky instanceof Scene)) this.#scene.backgroundNode = sky;
    this.cubeTarget = new CubeRenderTarget(size, { type: HalfFloatType, generateMipmaps: false });
    this.#camera = new CubeCamera(0.1, 1000, this.cubeTarget);
    // Behaviour reference only: Engine/Source/Runtime/Engine/Private/Components/SkyLightComponent.cpp
    // and Engine/Source/Runtime/Renderer/Private/ReflectionEnvironmentCapture.cpp (Unreal 5.8.3).
    if (options.lowerHemisphereBlack !== false) {
      this.#mask = new Scene();
      this.#maskMesh = new Mesh(
        new SphereGeometry(1, 32, 16, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
        new MeshBasicNodeMaterial({
          color: 0,
          side: BackSide,
          depthTest: false,
          depthWrite: false,
          toneMapped: false,
        }),
      );
      this.#mask.add(this.#maskMesh);
    }
  }

  get texture(): Texture | undefined {
    return this.#filtered?.texture;
  }

  /** True only when all six faces have been captured and PMREM-filtered. No timer. */
  update(sunDirection: Vector3): boolean {
    if (this.#disposed) throw new Error("SkyCapture is disposed.");
    const faces = this.#schedule.next(sunDirection);
    if (faces.length === 0) return false;
    const raw = this.#renderer;
    const target = raw.getRenderTarget();
    const face = raw.getActiveCubeFace();
    const mip = raw.getActiveMipmapLevel();
    const xr = raw.xr.enabled;
    const autoClear = raw.autoClear;
    const toneMapping = raw.toneMapping;
    try {
      raw.xr.enabled = false;
      raw.toneMapping = NoToneMapping;
      if (this.#camera.coordinateSystem !== raw.coordinateSystem) {
        this.#camera.coordinateSystem = raw.coordinateSystem;
        this.#camera.updateCoordinateSystem();
      }
      this.#camera.updateMatrixWorld(true);
      for (const index of faces) {
        const camera = this.#camera.children[index] as Camera;
        raw.setRenderTarget(this.cubeTarget, index, 0);
        raw.autoClear = true;
        raw.render(this.#scene, camera);
        if (this.#mask !== undefined) {
          raw.autoClear = false;
          raw.render(this.#mask, camera);
        }
      }
      if (faces[faces.length - 1] !== 5) return false;
      this.#pmrem ??= new PMREMGenerator(raw);
      this.#filtered = this.#pmrem.fromCubemap(this.cubeTarget.texture, this.#filtered);
      return true;
    } catch (error) {
      this.#schedule.reset();
      throw error;
    } finally {
      raw.setRenderTarget(target, face, mip);
      raw.xr.enabled = xr;
      raw.autoClear = autoClear;
      raw.toneMapping = toneMapping;
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.cubeTarget.dispose();
    this.#filtered?.dispose();
    this.#pmrem?.dispose();
    this.#maskMesh?.geometry.dispose();
    this.#maskMesh?.material.dispose();
  }
}
