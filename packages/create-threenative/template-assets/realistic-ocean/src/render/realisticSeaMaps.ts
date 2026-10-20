// Generated for you, and ThreeNative does not read it. The surface the material shades is not the
// raw displacement buffer: it needs the surface's slope and its horizontal Jacobian, and it needs
// foam that remembers where waves broke. Both are computed here, on the GPU, from the buffers
// `SpectralOcean` already writes, as one more compute-driven object the scene adds after the sea.
//
// Foam is stored in the waves' own (Lagrangian) coordinates: a texel is a patch of water, not a
// patch of space. Sampling it at a vertex's rest position therefore carries the foam along with the
// crest that made it, the grid tiles with the same period as the cascade it lives on, and a camera
// teleport cannot desynchronise it — there is no camera-relative history to lose.
//
// Adapted from web-ocean (MIT, Copyright (c) 2026 Maksymilian Dendura; see
// REALISTIC-OCEAN-LICENSE.txt): its derivative cascade textures and persistent foam clipmaps.
import type { SpectralOcean } from "@threenative/core";
import { Group } from "three";
import { Fn, float, instanceIndex, instancedArray, mix, uniform, vec4 } from "three/tsl";
import type { ComputeNode, Node, StorageBufferNode } from "three/webgpu";

/** Structural, so this file asks the engine for nothing but a `compute()`. */
interface IComputeHost {
  compute(nodes: unknown): void;
}

export interface ISeaMapsOptions {
  /**
   * Foam half-life in seconds. Foam falls as `exp(-ln2 * t / halfLife)`, so a larger number is a
   * longer-lived whitecap. Game-owned: it decides how the sea ages.
   */
  readonly foamHalfLife: number;
  /**
   * The Jacobian below which a wave is breaking. 1 is undisturbed water and 0 is a crest folding
   * over itself, so values near 0.6 foam the steepest few per cent of the surface.
   */
  readonly foamThreshold: number;
  /** How quickly foam saturates as the Jacobian drops below the threshold. */
  readonly foamGain: number;
  /** Cascade indices that carry a foam grid, finest first. Each one tiles with its own patch. */
  readonly foamCascades: readonly number[];
}

/** `(slopeX, slopeZ, dDx/dx, dDz/dz)` and `(dDx/dz)` per texel, in the cascade's own rest frame. */
interface ICascadeMaps {
  readonly slope: StorageBufferNode<"vec4">;
  readonly shear: StorageBufferNode<"vec4">;
}

type Fnode = Node<"float">;

/**
 * Bilinear read of a periodic storage grid at a world position.
 *
 * Nearest-texel reads make the shaded normal piecewise constant, and the sun's reflection then
 * breaks into axis-aligned rectangles; the two `mod`s are not redundant, because the first is still
 * negative left of the origin and a negative index reads whatever sits behind the buffer.
 */
function bilinear(
  read: (index: Fnode) => Node<"vec4">,
  resolution: number,
  patchSize: number,
  x: Fnode,
  z: Fnode,
): Node<"vec4"> {
  const grid = float(resolution);
  const u = x.div(patchSize).mul(grid);
  const v = z.div(patchSize).mul(grid);
  const u0 = u.floor();
  const v0 = v.floor();
  const wrap = (value: Fnode): Fnode => value.mod(grid).add(grid).mod(grid);
  const at = (cx: Fnode, cz: Fnode) => read(wrap(cz).mul(grid).add(wrap(cx)));
  const near = mix(at(u0, v0), at(u0.add(1), v0), u.sub(u0));
  const far = mix(at(u0, v0.add(1)), at(u0.add(1), v0.add(1)), u.sub(u0));
  return mix(near, far, v.sub(v0)) as Node<"vec4">;
}

export function sampleBilinear(
  buffer: StorageBufferNode<"vec4">,
  resolution: number,
  patchSize: number,
  x: Fnode,
  z: Fnode,
): Node<"vec4"> {
  return bilinear(
    (index) => buffer.element(index.toUint()) as Node<"vec4">,
    resolution,
    patchSize,
    x,
    z,
  );
}

/** The same read for a one-channel grid, in `.x`. */
export function sampleBilinearFloat(
  buffer: StorageBufferNode<"float">,
  resolution: number,
  patchSize: number,
  x: Fnode,
  z: Fnode,
): Fnode {
  return bilinear(
    (index) => vec4(buffer.element(index.toUint()), 0, 0, 0),
    resolution,
    patchSize,
    x,
    z,
  ).x;
}

export class SeaMaps extends Group {
  readonly warmupNodes: readonly ComputeNode[];
  readonly processCadence: "fixed" | "render";
  readonly foamCascades: readonly number[];

  #ocean: SpectralOcean;
  #cascades: ICascadeMaps[] = [];
  #foam: StorageBufferNode<"float">[] = [];
  #derivativePasses: ComputeNode[] = [];
  #foamPasses: ComputeNode[] = [];
  #clearPasses: ComputeNode[] = [];
  #time = 0;
  #lastTime: number | undefined;
  #pendingClear = true;
  #host: IComputeHost | undefined;
  #released = false;
  readonly #retain = uniform(1);
  readonly #halfLife: number;

  constructor(ocean: SpectralOcean, options: ISeaMapsOptions) {
    super();
    if (!Number.isFinite(options.foamHalfLife) || options.foamHalfLife <= 0)
      throw new Error("SeaMaps.foamHalfLife must be a positive number.");
    if (!Number.isFinite(options.foamThreshold) || !Number.isFinite(options.foamGain))
      throw new Error("SeaMaps.foamThreshold and foamGain must be finite numbers.");
    for (const index of options.foamCascades)
      if (!Number.isInteger(index) || index < 0 || index >= ocean.cascades.length)
        throw new Error(
          `SeaMaps.foamCascades names cascade ${index}, which the sea does not have.`,
        );
    this.#ocean = ocean;
    this.processCadence = ocean.processCadence;
    this.foamCascades = [...options.foamCascades];
    this.#halfLife = options.foamHalfLife;

    const size = ocean.resolution;
    const count = size * size;
    for (let c = 0; c < ocean.cascades.length; c += 1) {
      const slope = instancedArray(count, "vec4") as StorageBufferNode<"vec4">;
      const shear = instancedArray(count, "vec4") as StorageBufferNode<"vec4">;
      this.#cascades.push({ slope, shear });
      this.#derivativePasses.push(this.#derivativePass(c, slope, shear));
    }
    for (const c of this.foamCascades) {
      const foam = instancedArray(count, "float") as StorageBufferNode<"float">;
      this.#foam.push(foam);
      this.#foamPasses.push(this.#foamPass(c, foam, options));
      this.#clearPasses.push(Fn(() => foam.element(instanceIndex).assign(0))().compute(count));
    }
    this.warmupNodes = [...this.#derivativePasses, ...this.#foamPasses, ...this.#clearPasses];
    this.addEventListener("removed", this.#onRemoved);
  }

  get released(): boolean {
    return this.#released;
  }

  slope(cascade: number): StorageBufferNode<"vec4"> {
    return this.#cascadeMaps(cascade).slope;
  }

  shear(cascade: number): StorageBufferNode<"vec4"> {
    return this.#cascadeMaps(cascade).shear;
  }

  /** The foam grid of the `level`-th foam cascade (0 is the finest). */
  foam(level: number): StorageBufferNode<"float"> {
    const grid = this.#foam[level];
    if (grid === undefined) throw new Error(`SeaMaps has no foam level ${level}.`);
    return grid;
  }

  /** Seconds of wave time, the same clock the sea runs on. */
  advance(seconds: number): void {
    if (!Number.isFinite(seconds)) throw new Error("SeaMaps.advance needs a finite time.");
    this.#time = seconds;
  }

  /** Forget every whitecap. The next dispatch clears each foam grid before it injects any. */
  reset(): void {
    this.#pendingClear = true;
    this.#lastTime = undefined;
  }

  attachRenderer(renderer: IComputeHost): void {
    if (this.#released) throw new Error("SeaMaps cannot be attached after release.");
    this.#host = renderer;
  }

  process(renderer: IComputeHost | undefined = this.#host): void {
    if (this.#released) return;
    if (renderer === undefined) throw new Error("SeaMaps is not attached to a renderer.");
    const step = this.#lastTime === undefined ? 0 : this.#time - this.#lastTime;
    this.#lastTime = this.#time;
    // A paused or rewound clock decays nothing, and a long stall decays one step's worth, so a
    // hidden tab cannot wipe the foam and a teleport cannot invent age.
    const delta = Number.isFinite(step) && step > 0 ? Math.min(step, 0.1) : 0;
    this.#retain.value = 0.5 ** (delta / this.#halfLife);
    const passes: ComputeNode[] = [];
    if (this.#pendingClear) {
      passes.push(...this.#clearPasses);
      this.#pendingClear = false;
    }
    passes.push(...this.#derivativePasses, ...this.#foamPasses);
    renderer.compute(passes);
  }

  detach(): void {
    if (this.#released) return;
    this.removeEventListener("removed", this.#onRemoved);
    this.#host = undefined;
    for (const pass of this.warmupNodes) pass.dispose();
    for (const maps of this.#cascades) {
      maps.slope.value.dispose();
      maps.shear.value.dispose();
    }
    for (const grid of this.#foam) grid.value.dispose();
    this.#cascades = [];
    this.#foam = [];
    this.#released = true;
  }

  #onRemoved = (): void => this.detach();

  #cascadeMaps(cascade: number): ICascadeMaps {
    const maps = this.#cascades[cascade];
    if (maps === undefined) throw new Error(`SeaMaps has no cascade ${cascade}.`);
    return maps;
  }

  /** Central differences of the displacement, one texel either side, wrapping at the patch edge. */
  #derivativePass(
    cascade: number,
    slope: StorageBufferNode<"vec4">,
    shear: StorageBufferNode<"vec4">,
  ): ComputeNode {
    const size = this.#ocean.resolution;
    const grid = float(size);
    const texel = this.#ocean.cascadePatchSize(cascade) / size;
    const displacement = this.#ocean.cascadeDisplacement(cascade);
    return Fn(() => {
      const index = float(instanceIndex);
      const x = index.mod(grid);
      const y = index.div(grid).floor();
      const at = (cx: Fnode, cy: Fnode) =>
        displacement.element(cy.add(grid).mod(grid).mul(grid).add(cx.add(grid).mod(grid)).toUint());
      const east = at(x.add(1), y);
      const west = at(x.sub(1), y);
      const north = at(x, y.add(1));
      const south = at(x, y.sub(1));
      const scale = float(1 / (2 * texel));
      // Slope in the rest frame; the material divides by the Jacobian to get it in the world's.
      slope
        .element(instanceIndex)
        .assign(
          vec4(
            east.y.sub(west.y).mul(scale),
            north.y.sub(south.y).mul(scale),
            east.x.sub(west.x).mul(scale),
            north.z.sub(south.z).mul(scale),
          ),
        );
      shear.element(instanceIndex).assign(vec4(north.x.sub(south.x).mul(scale), 0, 0, 0));
    })().compute(size * size);
  }

  /** `foam = max(foam * decay, injection)`, at each texel's rest position. */
  #foamPass(
    cascade: number,
    foam: StorageBufferNode<"float">,
    options: ISeaMapsOptions,
  ): ComputeNode {
    const size = this.#ocean.resolution;
    const grid = float(size);
    const patch = this.#ocean.cascadePatchSize(cascade);
    const retain = this.#retain;
    const { foamThreshold, foamGain } = options;
    return Fn(() => {
      const index = float(instanceIndex);
      const x = index
        .mod(grid)
        .add(0.5)
        .mul(patch / size);
      const z = index
        .div(grid)
        .floor()
        .add(0.5)
        .mul(patch / size);
      const jxx = float(0).toVar();
      const jzz = float(0).toVar();
      const jxz = float(0).toVar();
      for (let c = 0; c < this.#cascades.length; c += 1) {
        const maps = this.#cascades[c] as ICascadeMaps;
        const patchSize = this.#ocean.cascadePatchSize(c);
        const slope = sampleBilinear(maps.slope, size, patchSize, x, z);
        jxx.addAssign(slope.z);
        jzz.addAssign(slope.w);
        jxz.addAssign(sampleBilinear(maps.shear, size, patchSize, x, z).x);
      }
      const jacobian = jxx.add(1).mul(jzz.add(1)).sub(jxz.mul(jxz));
      const injection = float(foamThreshold).sub(jacobian).mul(foamGain).clamp(0, 1);
      foam.element(instanceIndex).assign(foam.element(instanceIndex).mul(retain).max(injection));
    })().compute(size * size);
  }
}
