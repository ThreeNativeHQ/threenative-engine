/**
 * PRD-307 Phase 1: what does `scene.environment` actually cost, and which half can baking win?
 *
 * The direction document attributes ~6.3 ms of an 18-19 ms Pixel 8 frame to `scene.environment`,
 * measured by turning it off. That ablation removes **two** costs at once, and only one of them is
 * something a build machine could have done earlier:
 *
 * | cost                                              | paid            | baking wins it |
 * | ------------------------------------------------- | --------------- | -------------- |
 * | the PMREM prefilter of the environment texture     | once at load    | yes            |
 * | every material sampling it, every fragment, frame  | every frame     | **no**         |
 *
 * So 6.3 ms is an upper bound on what baking can win, not an estimate of it. This fixture separates
 * the two by running the identical scene three ways, chosen with `?arm=`:
 *
 * - `static`   the environment is set once and left alone — the shipping case
 * - `dirty`    `needsPMREMUpdate` is set every frame, so the prefilter runs per frame — the cost
 *              baking removes, made continuously visible. `ProbeVolume` does this for real at
 *              `probe-volume.ts:937` after each cube-face sweep.
 * - `none`     `scene.environment` is null — both costs gone
 *
 * `dirty` minus `static` is what baking can win. `static` minus `none` is what it cannot.
 *
 * Nothing here decides how a game looks: it is a measurement fixture, and the scene exists only to
 * make environment sampling expensive enough to read on the meter. Read the numbers from
 * `TN_FRAME_BUDGET`'s `gpuMs`.
 */
import { type ICtx, Scene, defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import {
  BackSide,
  DataTexture,
  EquirectangularReflectionMapping,
  FloatType,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type PerspectiveCamera,
  RGBAFormat,
  SphereGeometry,
  type Texture,
} from "three";

/** How the environment is driven this run. An unknown arm throws rather than picking one. */
export type EnvironmentArm = "static" | "dirty" | "none";

const ARMS: readonly EnvironmentArm[] = ["static", "dirty", "none"];

export function resolveArm(search: string): EnvironmentArm {
  const requested = new URLSearchParams(search).get("arm") ?? "static";
  if (!(ARMS as readonly string[]).includes(requested)) {
    throw new Error(
      `Unknown arm ${JSON.stringify(requested)} — expected one of ${ARMS.join(", ")}.`,
    );
  }
  return requested as EnvironmentArm;
}

/** How many frames pass between prefilters on the `dirty` arm. Only meaningful for that arm. */
export function resolveEvery(search: string): number {
  const raw = new URLSearchParams(search).get("every") ?? "1";
  const every = Number(raw);
  if (!Number.isInteger(every) || every < 1) {
    throw new Error(`Unusable every ${JSON.stringify(raw)} — expected a positive integer.`);
  }
  return every;
}

/**
 * A procedural equirectangular sky, so this fixture needs no asset and no network.
 *
 * Float RGBA on purpose: an LDR environment would let the prefilter take a cheaper path than a real
 * game's HDR probe does, and the whole question here is what the prefilter costs.
 */
export function proceduralEnvironment(width = 512, height = 256): DataTexture {
  const data = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const v = y / (height - 1);
    // A horizon gradient with a bright sun lobe: enough high-frequency energy that the prefilter
    // has real work to do at every mip.
    for (let x = 0; x < width; x += 1) {
      const u = x / (width - 1);
      const sun = Math.max(0, 1 - Math.hypot(u - 0.25, v - 0.3) * 6) ** 8;
      const offset = (y * width + x) * 4;
      data[offset] = 0.15 + v * 0.35 + sun * 12;
      data[offset + 1] = 0.2 + v * 0.45 + sun * 11;
      data[offset + 2] = 0.45 + v * 0.5 + sun * 9;
      data[offset + 3] = 1;
    }
  }
  const texture = new DataTexture(data, width, height, RGBAFormat, FloatType);
  texture.mapping = EquirectangularReflectionMapping;
  texture.needsUpdate = true;
  return texture;
}

/** Rough metal spheres: the population that pays the per-fragment sampling cost. */
function sampleField(scene: { add: (object: Mesh) => void }, count: number): void {
  const geometry = new SphereGeometry(0.5, 32, 24);
  // Ten shared materials, not one per sphere: roughness only takes ten values, and a material per
  // mesh compiles a pipeline per mesh — at 480 spheres that alone crashed the tab, before any
  // environment was measured.
  const materials = Array.from(
    { length: 10 },
    // A spread of roughness walks the whole prefiltered mip chain rather than one level.
    (_, step) => new MeshStandardMaterial({ metalness: 1, roughness: 0.05 + step * 0.09 }),
  );
  for (let index = 0; index < count; index += 1) {
    const material = materials[index % 10] as MeshStandardMaterial;
    const mesh = new Mesh(geometry, material);
    const ring = Math.floor(index / 24);
    const angle = ((index % 24) / 24) * Math.PI * 2;
    mesh.position.set(
      Math.cos(angle) * (2 + ring * 1.4),
      ring * 0.8 - 2,
      Math.sin(angle) * (2 + ring * 1.4),
    );
    scene.add(mesh);
  }
}

class EnvironmentCost extends Scene<Record<string, unknown>, undefined> {
  static override readonly initialState: Record<string, unknown> = {};

  #environment: Texture | undefined;
  #arm: EnvironmentArm = "static";
  #every = 1;
  #frame = 0;

  override enter(ctx: ICtx<Record<string, unknown>, undefined>): void {
    const search = globalThis.location?.search ?? "";
    this.#arm = resolveArm(search);
    this.#every = resolveEvery(search);
    const camera = ctx.camera as PerspectiveCamera;
    camera.position.set(0, 0, 9);
    camera.lookAt(0, 0, 0);

    // A visible backdrop so a capture is never blank, drawn unlit so it costs nothing to sample.
    const backdrop = new Mesh(
      new SphereGeometry(60, 32, 16),
      new MeshBasicMaterial({ color: 0x0b1024, side: BackSide }),
    );
    ctx.add(backdrop);
    sampleField(ctx, 480);

    if (this.#arm !== "none") {
      this.#environment = proceduralEnvironment();
      ctx.scene.environment = this.#environment;
    }
    console.info(
      `TN_ENV_ARM:${JSON.stringify({ arm: this.#arm, every: this.#every, marker: "TN_ENV_ARM" })}`,
    );
  }

  override update(): void {
    // The one line the whole fixture exists for. `ProbeVolume` sets exactly this flag after every
    // completed cube-face sweep, so a game driving one re-prefilters inside the frame loop; here it
    // is set on a fixed cadence so the cost is continuous and readable rather than a startup spike.
    //
    // The cadence is not a convenience. At `every=1` the tab dies inside 60 s — re-prefiltering on
    // every frame exhausts GPU resources before the meter has enough windows to report. A cadence
    // of N amortises one prefilter over N frames, so the per-prefilter cost is
    // `(gpuMs(dirty) - gpuMs(static)) * N`.
    if (this.#arm !== "dirty" || this.#environment === undefined) return;
    this.#frame += 1;
    if (this.#frame % this.#every !== 0) return;
    (this.#environment as { needsPMREMUpdate?: boolean }).needsPMREMUpdate = true;
  }
}

export default defineGame<Record<string, unknown>>({
  plugins: [playtest()],
  renderer: { preferWebGPU: true },
  scenes: { play: EnvironmentCost },
  start: "play",
});
