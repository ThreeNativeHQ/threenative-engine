import { Object3D } from "three";
import { Fn, float, instanceIndex, instancedArray, uniform, vec2, vec4 } from "three/tsl";
import type { ComputeNode, StorageBufferNode } from "three/webgpu";
import type { IComputeDriven } from "../compute-driven.js";
import { GPUReadback } from "../gpu-readback.js";
import { createRandom } from "../random.js";
import type { IRendererLike } from "../renderer.js";
import { bitReverseIndices, butterflyStageCount, log2Exact } from "./fft.js";

/** One band of the spectrum, drawn on its own patch. */
export interface ISpectralOceanCascade {
  /** The world-space edge length, in metres, this cascade's grid tiles across. */
  readonly patchSize: number;
}

export interface ISpectralOceanOptions {
  /** Grid resolution per cascade. A power of two; the transform has no other shape. */
  readonly resolution: number;
  /**
   * The cascades, largest patch first.
   *
   * Each one carries only the wavelengths the next-smaller patch cannot resolve, so the bands do
   * not overlap and a wave is never counted twice. One cascade is a toy: the join between bands is
   * where a spectral ocean visibly fails, so there is nothing to look at until there are two.
   */
  readonly cascades: readonly ISpectralOceanCascade[];
  readonly windSpeed: number;
  /** Wind heading in radians. */
  readonly windDirection: number;
  readonly gravity: number;
  /** Overall spectrum scale. A wave height decision, so the game owns the number. */
  readonly amplitude: number;
  /**
   * How sharply waves align with the wind, as the exponent on the directional spread.
   *
   * A spectrum-tuning number with no defensible default, so there is none.
   */
  readonly directionality: number;
  /** Horizontal displacement scale. Zero is a pure heightfield; higher values sharpen crests. */
  readonly choppiness: number;
  /** Waves shorter than this are cut off, in metres. */
  readonly smallWaveCutoff: number;
  readonly seed: number;
  /**
   * Which clock advances the simulation. Defaults to the game's fixed step.
   *
   * Fixed, because this sea is something the game reads: `sampleHeight` reports its age in frames,
   * and a field advanced by the display makes that age mean a different amount of time on every
   * machine. A game whose ocean is only ever looked at can pass `"render"` and pay for exactly the
   * frames it draws.
   */
  readonly cadence?: "fixed" | "render";
  /**
   * The grid the CPU height query is sampled on, per side. Zero disables the query entirely.
   *
   * This is not the simulation resolution. It is the size of the only thing copied back off the
   * GPU, so it is the whole cost of being able to float something: `readbackResolution` squared
   * pairs of height and vertical-velocity floats, every `readbackEveryFrames` frames.
   */
  readonly readbackResolution: number;
  /** Frames between height copies. Ignored when `readbackResolution` is zero. */
  readonly readbackEveryFrames: number;
}

/** A height read from the CPU copy, with the age of the frame that produced it. */
export interface ISpectralOceanHeight {
  readonly height: number;
  /** Metres per second at this same point and sample time, for temporal age correction. */
  readonly verticalVelocity: number;
  /**
   * Frames between the GPU state this height came from and now.
   *
   * A spectral ocean cannot offer an exact CPU height — there is no closed form, only texels the
   * GPU made — so this number is the contract. A caller that ignores it floats a hull on water
   * that is not the water being drawn, and nothing in the frame says so.
   */
  readonly staleFrames: number;
}

interface ICascadeState {
  readonly patchSize: number;
  readonly kMin: number;
  readonly kMax: number;
  readonly initialSpectrum: StorageBufferNode<"vec4">;
  readonly work: StorageBufferNode<"vec4">;
  readonly scratch: StorageBufferNode<"vec4">;
  readonly displacement: StorageBufferNode<"vec4">;
  readonly passes: readonly ComputeNode[];
}

const TWO_PI = Math.PI * 2;

function positiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`SpectralOcean.${name} must be a positive integer.`);
  return value;
}

function finiteNumber(name: string, value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`SpectralOcean.${name} must be a finite number.`);
  return value;
}

function positiveNumber(name: string, value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    throw new Error(`SpectralOcean.${name} must be a positive number.`);
  return value;
}

/**
 * The band each cascade owns, so no wavelength is simulated twice.
 *
 * A cascade resolves wavenumbers up to its own Nyquist. Giving each one everything below its
 * Nyquist and above the previous, larger patch's Nyquist partitions the spectrum exactly. Summing
 * overlapping cascades instead is the classic spectral-ocean bug: the water is too tall, and it is
 * too tall in a way that reads as "the amplitude needs tuning".
 */
export function cascadeBands(
  resolution: number,
  cascades: readonly ISpectralOceanCascade[],
): readonly { readonly kMin: number; readonly kMax: number }[] {
  const bands: { kMin: number; kMax: number }[] = [];
  for (let index = 0; index < cascades.length; index += 1) {
    const nyquist = (Math.PI * resolution) / (cascades[index] as ISpectralOceanCascade).patchSize;
    const previous =
      index === 0
        ? 0
        : (Math.PI * resolution) / (cascades[index - 1] as ISpectralOceanCascade).patchSize;
    bands.push({
      kMin: previous,
      kMax: index === cascades.length - 1 ? Number.POSITIVE_INFINITY : nyquist,
    });
  }
  return bands;
}

/**
 * The Phillips spectrum's energy at one wavenumber, band-limited to one cascade.
 *
 * On the CPU on purpose. Everything here is a decision a test can check — a spectrum that is
 * subtly wrong produces an ocean that still looks like an ocean, so "it moves and it is blue" is
 * not evidence of anything.
 */
export function phillipsEnergy(
  kx: number,
  kz: number,
  options: {
    readonly windSpeed: number;
    readonly windDirection: number;
    readonly gravity: number;
    readonly amplitude: number;
    readonly directionality: number;
    readonly smallWaveCutoff: number;
    readonly kMin: number;
    readonly kMax: number;
  },
): number {
  const kLength = Math.hypot(kx, kz);
  if (kLength < 1e-6) return 0;
  if (kLength < options.kMin || kLength >= options.kMax) return 0;
  const largestWave = (options.windSpeed * options.windSpeed) / options.gravity;
  const alignment =
    (kx * Math.cos(options.windDirection) + kz * Math.sin(options.windDirection)) / kLength;
  // Waves running against the wind carry no energy; the exponent is how sharply that falls off.
  if (alignment <= 0) return 0;
  const spread = alignment ** (2 * options.directionality);
  const kSquared = kLength * kLength;
  const suppression = Math.exp(-1 / (kSquared * largestWave * largestWave));
  const cutoff = Math.exp(-kSquared * options.smallWaveCutoff * options.smallWaveCutoff);
  return (options.amplitude * suppression * spread * cutoff) / (kSquared * kSquared);
}

/**
 * The complex amplitudes at t=0 for one cascade, packed as `(h0, conj(h0(-k)))` per texel.
 *
 * Exported because determinism is a claim this makes and a test has to be able to check it: the
 * same seed and the same parameters must produce the same field, or nothing downstream can be
 * asserted at all.
 */
export function initialSpectrumData(
  resolution: number,
  patchSize: number,
  band: { readonly kMin: number; readonly kMax: number },
  options: {
    readonly windSpeed: number;
    readonly windDirection: number;
    readonly gravity: number;
    readonly amplitude: number;
    readonly directionality: number;
    readonly smallWaveCutoff: number;
    readonly seed: number;
  },
): Float32Array {
  const random = createRandom(options.seed);
  const count = resolution * resolution;
  const gaussian = new Float32Array(count * 2);
  for (let index = 0; index < count; index += 1) {
    // Box-Muller from the seeded stream: two independent standard normals per texel.
    const first = Math.max(random(), 1e-9);
    const second = random();
    const radius = Math.sqrt(-2 * Math.log(first));
    gaussian[index * 2] = radius * Math.cos(TWO_PI * second);
    gaussian[index * 2 + 1] = radius * Math.sin(TWO_PI * second);
  }

  const data = new Float32Array(count * 4);
  const step = TWO_PI / patchSize;
  // Each sample stands for one cell of the wavenumber plane, so it carries that cell's width.
  // Without it `amplitude` would mean a different wave height at every patch size.
  const spacing = step;
  const half = resolution / 2;
  const energyOptions = { ...options, kMin: band.kMin, kMax: band.kMax };
  for (let y = 0; y < resolution; y += 1) {
    for (let x = 0; x < resolution; x += 1) {
      const index = y * resolution + x;
      const kx = (x - half) * step;
      const kz = (y - half) * step;
      // The Nyquist row is its own mirror — negating its wavevector lands back on itself — so it
      // cannot carry a conjugate pair. Left in, it makes the spectrum non-Hermitian along one line
      // of texels and leaks an imaginary part into the height. One texel row of the shortest
      // resolvable wave is the whole cost of dropping it.
      const selfMirrored = x === 0 || y === 0;
      const amplitude = selfMirrored
        ? 0
        : Math.sqrt(phillipsEnergy(kx, kz, energyOptions) / 2) * spacing;
      data[index * 4] = (gaussian[index * 2] as number) * amplitude;
      data[index * 4 + 1] = (gaussian[index * 2 + 1] as number) * amplitude;

      // conj(h0(-k)): the mirrored texel's noise against the mirrored wavevector's energy. This
      // is what makes the spectrum Hermitian, and a Hermitian spectrum is what makes the inverse
      // transform produce a real height instead of half of one.
      const mirrorX = (resolution - x) % resolution;
      const mirrorY = (resolution - y) % resolution;
      const mirror = mirrorY * resolution + mirrorX;
      const mirrorAmplitude = selfMirrored
        ? 0
        : Math.sqrt(phillipsEnergy(-kx, -kz, energyOptions) / 2) * spacing;
      data[index * 4 + 2] = (gaussian[mirror * 2] as number) * mirrorAmplitude;
      data[index * 4 + 3] = -(gaussian[mirror * 2 + 1] as number) * mirrorAmplitude;
    }
  }
  return data;
}

/**
 * Bilinear height at a world position, from a square grid that tiles every `patchSize` metres.
 *
 * Separated from the class so the sampling can be tested against a field a test wrote itself,
 * rather than against whatever the GPU happened to produce.
 */
export function sampleGrid(
  grid: Float32Array,
  resolution: number,
  patchSize: number,
  x: number,
  z: number,
  stride = 1,
  offset = 0,
): number {
  const scale = resolution / patchSize;
  const u = x * scale;
  const v = z * scale;
  const x0 = Math.floor(u);
  const v0 = Math.floor(v);
  const fx = u - x0;
  const fz = v - v0;
  const wrap = (value: number) => ((value % resolution) + resolution) % resolution;
  const xa = wrap(x0);
  const xb = wrap(x0 + 1);
  const za = wrap(v0);
  const zb = wrap(v0 + 1);
  const topLeft = grid[(za * resolution + xa) * stride + offset] as number;
  const topRight = grid[(za * resolution + xb) * stride + offset] as number;
  const bottomLeft = grid[(zb * resolution + xa) * stride + offset] as number;
  const bottomRight = grid[(zb * resolution + xb) * stride + offset] as number;
  const top = topLeft + (topRight - topLeft) * fx;
  const bottom = bottomLeft + (bottomRight - bottomLeft) * fx;
  return top + (bottom - top) * fz;
}

/**
 * A spectral ocean: cascaded wave spectra, inverse-transformed on the GPU every frame.
 *
 * It draws nothing. The game builds its own mesh and its own material and reads
 * `cascadeDisplacement(index)`; every colour, every foam threshold, every sky this water reflects
 * is the game's, and none of it can be changed from here.
 *
 * What it offers that an analytic wave function cannot is the look. What it cannot offer is an
 * exact CPU height: there is no closed form, only the texels the GPU produced, so `sampleHeight`
 * is a throttled copy that is always some frames behind and always says how many. A game that
 * needs the height to be exact wants an analytic field instead — that is a different contract, and
 * the reason this class has a different name rather than a flag.
 */
export class SpectralOcean extends Object3D implements IComputeDriven {
  readonly resolution: number;
  readonly cascades: readonly ISpectralOceanCascade[];
  readonly processCadence: "fixed" | "render";
  readonly warmupNodes: readonly ComputeNode[];
  /** Floats copied off the GPU per readback, so a report can state the cost rather than imply it. */
  readonly readbackFloats: number;

  #time = uniform(0);
  #heightDelta = uniform(0);
  #heightTime: number | undefined;
  #cascadeStates: ICascadeState[] = [];
  #heightField: StorageBufferNode<"vec2"> | undefined;
  #heightPass: ComputeNode | undefined;
  #readback: GPUReadback | undefined;
  #readbackResolution: number;
  #renderer: IRendererLike | undefined;
  #released = false;
  #steps = 0;

  constructor(options: ISpectralOceanOptions) {
    super();
    const resolution = positiveInteger("resolution", options.resolution);
    log2Exact(resolution);
    if (!Array.isArray(options.cascades) || options.cascades.length === 0)
      throw new Error("SpectralOcean.cascades must hold at least one cascade.");
    for (const cascade of options.cascades)
      positiveNumber("cascades[].patchSize", cascade.patchSize);
    for (let index = 1; index < options.cascades.length; index += 1) {
      if (
        (options.cascades[index] as ISpectralOceanCascade).patchSize >=
        (options.cascades[index - 1] as ISpectralOceanCascade).patchSize
      ) {
        throw new Error(
          "SpectralOcean.cascades must be ordered from largest patchSize to smallest.",
        );
      }
    }
    positiveNumber("windSpeed", options.windSpeed);
    finiteNumber("windDirection", options.windDirection);
    positiveNumber("gravity", options.gravity);
    positiveNumber("amplitude", options.amplitude);
    positiveNumber("directionality", options.directionality);
    finiteNumber("choppiness", options.choppiness);
    positiveNumber("smallWaveCutoff", options.smallWaveCutoff);
    finiteNumber("seed", options.seed);
    if (!Number.isInteger(options.readbackResolution) || options.readbackResolution < 0)
      throw new Error("SpectralOcean.readbackResolution must be a non-negative integer.");
    if (options.readbackResolution > 0) {
      log2Exact(options.readbackResolution);
      positiveInteger("readbackEveryFrames", options.readbackEveryFrames);
    }

    if (
      options.cadence !== undefined &&
      options.cadence !== "fixed" &&
      options.cadence !== "render"
    )
      throw new Error('SpectralOcean.cadence must be "fixed" or "render".');
    this.processCadence = options.cadence ?? "fixed";
    this.resolution = resolution;
    this.cascades = [...options.cascades];
    this.#readbackResolution = options.readbackResolution;
    this.readbackFloats = options.readbackResolution * options.readbackResolution * 2;

    const bands = cascadeBands(resolution, this.cascades);
    const warmup: ComputeNode[] = [];
    for (let index = 0; index < this.cascades.length; index += 1) {
      const cascade = this.cascades[index] as ISpectralOceanCascade;
      const band = bands[index] as { kMin: number; kMax: number };
      const state = this.#buildCascade(cascade.patchSize, band, {
        amplitude: options.amplitude,
        choppiness: options.choppiness,
        directionality: options.directionality,
        gravity: options.gravity,
        // Each cascade draws from its own stream so two cascades never share a wave.
        seed: options.seed + index * 7919,
        smallWaveCutoff: options.smallWaveCutoff,
        windDirection: options.windDirection,
        windSpeed: options.windSpeed,
      });
      this.#cascadeStates.push(state);
      warmup.push(...state.passes);
    }

    if (this.#readbackResolution > 0) {
      const { field, pass } = this.#buildHeightPass(this.#readbackResolution);
      this.#heightField = field;
      this.#heightPass = pass;
      warmup.push(pass);
      this.#readback = new GPUReadback({
        attribute: field.value,
        everyFrames: options.readbackEveryFrames,
      });
    }
    this.warmupNodes = warmup;
    this.addEventListener("removed", this.#onRemoved);
  }

  get released(): boolean {
    return this.#released;
  }

  /** Simulation steps dispatched. A report that cannot count its own dispatches proves nothing. */
  get steps(): number {
    return this.#steps;
  }

  /** How old the CPU height copy is, or `undefined` when the height query is switched off. */
  get staleFrames(): number | undefined {
    return this.#readback?.staleFrames;
  }

  /** The `(displaceX, height, displaceZ, fold)` buffer the game's material reads. */
  cascadeDisplacement(index: number): StorageBufferNode<"vec4"> {
    const state = this.#cascadeStates[index];
    if (state === undefined) throw new Error(`SpectralOcean has no cascade ${index}.`);
    return state.displacement;
  }

  /** The world-space tile size of one cascade, which the game's material needs to place it. */
  cascadePatchSize(index: number): number {
    const state = this.#cascadeStates[index];
    if (state === undefined) throw new Error(`SpectralOcean has no cascade ${index}.`);
    return state.patchSize;
  }

  /** Seconds of wave time. The game advances it, so a paused game has a paused sea. */
  advance(seconds: number): void {
    if (!Number.isFinite(seconds)) throw new Error("SpectralOcean.advance needs a finite time.");
    this.#time.value = seconds;
  }

  /**
   * The surface height at a world position, and how many frames behind it is.
   *
   * `undefined` until the first copy lands, and `undefined` forever when the height query was
   * switched off — never zero, because a hull floating at zero is indistinguishable from a hull
   * floating at sea level and that is exactly the mistake this must not allow.
   */
  sampleHeight(x: number, z: number): ISpectralOceanHeight | undefined {
    if (this.#readback === undefined) return undefined;
    const sample = this.#readback.sample;
    if (sample === undefined) return undefined;
    const patch = (this.#cascadeStates[0] as ICascadeState).patchSize;
    return {
      height: sampleGrid(sample.data, this.#readbackResolution, patch, x, z, 2),
      verticalVelocity: sampleGrid(sample.data, this.#readbackResolution, patch, x, z, 2, 1),
      staleFrames: sample.staleFrames,
    };
  }

  attachRenderer(renderer: IRendererLike): void {
    if (this.#released) throw new Error("SpectralOcean cannot be attached after release.");
    this.#renderer = renderer;
  }

  process(renderer = this.#renderer): void {
    if (this.#released) return;
    if (renderer === undefined) throw new Error("SpectralOcean is not attached to a renderer.");
    // One `compute()` for the whole transform. Three submits a command buffer per call, so a call
    // per pass was ~20 submits a frame for two cascades, and a submit is where the GPU process
    // makes the renderer wait: 60 submits a frame with a 70 ms stall every few dozen of them.
    // An array runs in one compute pass in order, which is all a ping-pong transform needs.
    const passes = this.#cascadeStates.flatMap((state) => state.passes);
    if (this.#heightPass !== undefined) {
      const now = this.#time.value;
      const delta = now - (this.#heightTime ?? now);
      this.#heightDelta.value = Number.isFinite(delta) && delta > 0 ? delta : 0;
      this.#heightTime = now;
      passes.push(this.#heightPass);
    }
    renderer.compute(passes);
    if (this.#heightPass !== undefined) this.#readback?.request(renderer);
    this.#steps += 1;
  }

  detach(): void {
    if (this.#released) return;
    this.removeEventListener("removed", this.#onRemoved);
    this.#renderer = undefined;
    for (const state of this.#cascadeStates) {
      for (const pass of state.passes) pass.dispose();
      state.initialSpectrum.value.dispose();
      state.work.value.dispose();
      state.scratch.value.dispose();
      state.displacement.value.dispose();
    }
    this.#cascadeStates = [];
    this.#heightPass?.dispose();
    this.#heightField?.value.dispose();
    this.#heightPass = undefined;
    this.#heightField = undefined;
    this.#readback?.dispose();
    this.#readback = undefined;
    this.#released = true;
  }

  #onRemoved = (): void => this.detach();

  #buildCascade(
    patchSize: number,
    band: { readonly kMin: number; readonly kMax: number },
    tuning: {
      readonly amplitude: number;
      readonly choppiness: number;
      readonly directionality: number;
      readonly gravity: number;
      readonly seed: number;
      readonly smallWaveCutoff: number;
      readonly windDirection: number;
      readonly windSpeed: number;
    },
  ): ICascadeState {
    const size = this.resolution;
    const count = size * size;
    const initial = instancedArray(
      initialSpectrumData(size, patchSize, band, tuning),
      "vec4",
    ) as StorageBufferNode<"vec4">;
    const work = instancedArray(count, "vec4") as StorageBufferNode<"vec4">;
    const scratch = instancedArray(count, "vec4") as StorageBufferNode<"vec4">;
    const displacement = instancedArray(count, "vec4") as StorageBufferNode<"vec4">;
    const reversal = instancedArray(
      Float32Array.from(bitReverseIndices(size)),
      "float",
    ) as StorageBufferNode<"float">;

    const gridSize = float(size);
    const time = this.#time;
    const passes: ComputeNode[] = [];

    // Spectrum evolution: h(k, t) from the fixed amplitudes, packed as two complex fields so one
    // transform carries four real outputs — height and displaceX in the first, displaceZ and the
    // fold in the second.
    passes.push(
      Fn(() => {
        const index = float(instanceIndex);
        const x = index.mod(gridSize);
        const y = index.div(gridSize).floor();
        const step = float(TWO_PI / patchSize);
        const kx = x.sub(gridSize.mul(0.5)).mul(step);
        const kz = y.sub(gridSize.mul(0.5)).mul(step);
        const kLength = kx.mul(kx).add(kz.mul(kz)).sqrt().max(1e-6);
        const omega = kLength.mul(tuning.gravity).sqrt().mul(time);
        const cos = omega.cos();
        const sin = omega.sin();
        const amplitudes = initial.element(instanceIndex);
        const heightRe = amplitudes.x
          .mul(cos)
          .sub(amplitudes.y.mul(sin))
          .add(amplitudes.z.mul(cos))
          .add(amplitudes.w.mul(sin));
        const heightIm = amplitudes.x
          .mul(sin)
          .add(amplitudes.y.mul(cos))
          .sub(amplitudes.z.mul(sin))
          .add(amplitudes.w.mul(cos));
        // Multiplying by -i turns the height spectrum into a horizontal displacement spectrum.
        const displaceXRe = kx.div(kLength).mul(heightIm);
        const displaceXIm = kx.div(kLength).mul(heightRe).negate();
        const displaceZRe = kz.div(kLength).mul(heightIm);
        const displaceZIm = kz.div(kLength).mul(heightRe).negate();
        // The trace of the horizontal displacement's Jacobian: how much the surface folds onto
        // itself. It is a simulation quantity; what counts as foam is the game's threshold.
        const foldRe = kLength.mul(heightRe);
        const foldIm = kLength.mul(heightIm);
        work
          .element(instanceIndex)
          .assign(
            vec4(
              heightRe.sub(displaceXIm),
              heightIm.add(displaceXRe),
              displaceZRe.sub(foldIm),
              displaceZIm.add(foldRe),
            ),
          );
      })().compute(count),
    );

    // The transform: gather into bit-reversed order, then one in-place butterfly stage per pass,
    // rows first and then columns. Each stage's pairs touch disjoint slots, so a stage needs no
    // barrier and no ping-pong buffer.
    passes.push(this.#reversePass(work, scratch, reversal, "row"));
    for (let stage = 0; stage < butterflyStageCount(size); stage += 1) {
      passes.push(this.#butterflyPass(scratch, stage, "row"));
    }
    passes.push(this.#reversePass(scratch, work, reversal, "column"));
    for (let stage = 0; stage < butterflyStageCount(size); stage += 1) {
      passes.push(this.#butterflyPass(work, stage, "column"));
    }

    // Unpack: normalise by the transform length and undo the half-grid origin shift the
    // wavevectors were built around.
    passes.push(
      Fn(() => {
        const index = float(instanceIndex);
        const x = index.mod(gridSize);
        const y = index.div(gridSize).floor();
        // No 1/N² here on purpose. The wave synthesis is the unnormalised sum
        // `h(x) = Σ h̃(k,t)·e^{ik·x}`; the transform's length is not part of it. Dividing by it
        // made the sea shrink four-fold every time a game doubled `resolution`, which is a quality
        // knob and must not be a wave-height knob. The physical scale rides on `Δk` in `h0`.
        const sign = x.add(y).mod(2).mul(-2).add(1);
        const scale = sign;
        const transformed = work.element(instanceIndex);
        displacement
          .element(instanceIndex)
          .assign(
            vec4(
              transformed.y.mul(scale).mul(tuning.choppiness),
              transformed.x.mul(scale),
              transformed.z.mul(scale).mul(tuning.choppiness),
              transformed.w.mul(scale),
            ),
          );
      })().compute(count),
    );

    return {
      patchSize,
      kMin: band.kMin,
      kMax: band.kMax,
      initialSpectrum: initial,
      work,
      scratch,
      displacement,
      passes,
    };
  }

  #reversePass(
    source: StorageBufferNode<"vec4">,
    target: StorageBufferNode<"vec4">,
    reversal: StorageBufferNode<"float">,
    axis: "row" | "column",
  ): ComputeNode {
    const size = this.resolution;
    const count = size * size;
    const gridSize = float(size);
    return Fn(() => {
      const index = float(instanceIndex);
      const column = index.mod(gridSize);
      const row = index.div(gridSize).floor();
      const moved =
        axis === "row"
          ? row.mul(gridSize).add(reversal.element(column.toUint()))
          : reversal.element(row.toUint()).mul(gridSize).add(column);
      target.element(instanceIndex).assign(source.element(moved.toUint()));
    })().compute(count);
  }

  #butterflyPass(
    buffer: StorageBufferNode<"vec4">,
    stage: number,
    axis: "row" | "column",
  ): ComputeNode {
    const size = this.resolution;
    const half = 1 << stage;
    const pairsPerLine = size / 2;
    const gridSize = float(size);
    return Fn(() => {
      const thread = float(instanceIndex);
      const line = thread.div(float(pairsPerLine)).floor();
      const pair = thread.mod(float(pairsPerLine));
      const twiddleIndex = pair.mod(float(half));
      const low = pair
        .div(float(half))
        .floor()
        .mul(float(half * 2))
        .add(twiddleIndex);
      const high = low.add(float(half));
      const angle = twiddleIndex.mul(float(TWO_PI / (2 * half)));
      const wRe = angle.cos();
      const wIm = angle.sin();
      const lowIndex = axis === "row" ? line.mul(gridSize).add(low) : low.mul(gridSize).add(line);
      const highIndex =
        axis === "row" ? line.mul(gridSize).add(high) : high.mul(gridSize).add(line);
      const a = buffer.element(lowIndex.toUint()).toVar();
      const b = buffer.element(highIndex.toUint()).toVar();
      const firstRe = b.x.mul(wRe).sub(b.y.mul(wIm));
      const firstIm = b.x.mul(wIm).add(b.y.mul(wRe));
      const secondRe = b.z.mul(wRe).sub(b.w.mul(wIm));
      const secondIm = b.z.mul(wIm).add(b.w.mul(wRe));
      buffer
        .element(lowIndex.toUint())
        .assign(vec4(a.x.add(firstRe), a.y.add(firstIm), a.z.add(secondRe), a.w.add(secondIm)));
      buffer
        .element(highIndex.toUint())
        .assign(vec4(a.x.sub(firstRe), a.y.sub(firstIm), a.z.sub(secondRe), a.w.sub(secondIm)));
    })().compute(size * pairsPerLine);
  }

  /**
   * Sums every cascade's height onto one small grid, which is the only thing copied to the CPU.
   *
   * Reading the simulation grids back instead would move megabytes a frame to answer a question
   * about a handful of floating bodies. This pass answers it at the resolution the caller actually
   * asked for.
   */
  #buildHeightPass(readbackResolution: number): {
    field: StorageBufferNode<"vec2">;
    pass: ComputeNode;
  } {
    const count = readbackResolution * readbackResolution;
    const field = instancedArray(count, "vec2") as StorageBufferNode<"vec2">;
    const states = this.#cascadeStates;
    const basePatch = (states[0] as ICascadeState).patchSize;
    const simulationSize = this.resolution;
    const pass = Fn(() => {
      const index = float(instanceIndex);
      const gridSize = float(readbackResolution);
      const x = index.mod(gridSize);
      const y = index.div(gridSize).floor();
      const worldX = x.div(gridSize).mul(float(basePatch));
      const worldZ = y.div(gridSize).mul(float(basePatch));
      const total = float(0).toVar();
      for (const state of states) {
        const scale = float(simulationSize / state.patchSize);
        const sampleX = worldX.mul(scale).floor().mod(float(simulationSize));
        const sampleZ = worldZ.mul(scale).floor().mod(float(simulationSize));
        const offset = sampleZ.mul(float(simulationSize)).add(sampleX);
        total.addAssign(state.displacement.element(offset.toUint()).y);
      }
      const previous = field.element(instanceIndex).x.toVar();
      const delta = this.#heightDelta;
      const velocity = delta
        .greaterThan(0)
        .select(total.sub(previous).div(delta.max(1e-6)), float(0));
      field.element(instanceIndex).assign(vec2(total, velocity));
    })().compute(count);
    return { field, pass };
  }
}
