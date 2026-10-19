import type { DepthTexture } from "three";
import { Vector2 } from "three";
import {
  Fn,
  If,
  Return,
  abs,
  ceil,
  clamp,
  float,
  instanceIndex,
  int,
  ivec2,
  log2,
  max,
  min,
  pow,
  storage,
  textureLoad,
  uniform,
  vec3,
  vec4,
} from "three/tsl";
import { StorageBufferAttribute } from "three/webgpu";

/**
 * The hierarchical-depth (pyramid) occlusion test, and the max-distance pyramid it reads.
 *
 * The pyramid is a previous frame's own depth, reduced so that one texel of a level covers `2^level`
 * pixels of the level below it and every texel holds the *farthest* surface inside its footprint.
 * Farthest, not nearest: a sphere is only hidden when its nearest point is behind the farthest
 * thing already drawn in front of it, so a max reduction is the conservative direction and a min
 * reduction would reject objects a fragment can still see.
 *
 * Two readers, one rule. {@link occludedBy} is the reference in plain TypeScript and
 * {@link DepthPyramid.occluded} is the same rule in TSL for the cull kernel. Four answers are never
 * "hidden", and each is a case the test has to get right rather than a tuning choice:
 * - a camera cut — a teleport or a projection change — skips the test for the whole frame, because
 *   the pyramid is a different camera's depth;
 * - a sphere that touches the near plane has no last-frame screen rect to compare against;
 * - a sphere that fell off screen last frame has no texel to read;
 * - a sphere whose footprint is a single texel at every level is kept, because the level it would
 *   need does not exist and a coarser level would reject it wrongly.
 *
 * Nothing here decides a look: the test reads depths and answers a boolean.
 */

/** The launch flag. */
export const OCCLUSION_FLAG = "TN_OCCLUSION";

/** What a launch asked the GPU-scene occlusion cull to do. `measure` counts; `off` runs no test. */
export type OcclusionMode = "off" | "measure";

/**
 * What this launch asked for.
 *
 * @situation measure what a pyramid occlusion cull would cull on map-walk, without culling it
 * @constraint `measure` never changes what is drawn: it runs the test and counts the answer, so a
 *   measured frame is the frame an unmeasured run draws. `off`, the default, runs no test and
 *   allocates nothing. An unknown value throws rather than picking one.
 * @example WorldCells.load({ ...options, gpuScene: true, occlusion: occlusionMode() });
 *
 * Read the way `gpuSceneRequested` reads its own: a native launch sets the environment variable, a
 * browser asks with `?tnOcclusion=measure`, and a test sets the global.
 */
export function occlusionMode(): OcclusionMode {
  const host = globalThis as {
    process?: { env?: Record<string, unknown> };
    __tnOcclusion?: unknown;
    location?: { search?: string };
  };
  const fromEnv = host.process?.env?.[OCCLUSION_FLAG];
  const query = host.location?.search;
  const asked =
    typeof fromEnv === "string" && fromEnv !== ""
      ? fromEnv
      : typeof query === "string"
        ? (/[?&]tnOcclusion=([^&]*)/u.exec(query)?.[1] ?? "")
        : typeof host.__tnOcclusion === "string"
          ? host.__tnOcclusion
          : "";
  const value = asked.trim().toLowerCase();
  if (value === "" || value === "0" || value === "off" || value === "false") return "off";
  if (value === "measure" || value === "1" || value === "true") return "measure";
  throw new Error(`${OCCLUSION_FLAG}: unknown mode "${asked}". Use "off" or "measure".`);
}

/** One level of the pyramid: the farthest view-axis distance each texel of it saw, in metres. */
export interface IDepthPyramidLevel {
  readonly width: number;
  readonly height: number;
  readonly distance: Float32Array;
}

/** The max-distance chain, level 0 first and the coarsest last. */
export interface IDepthPyramid {
  readonly levels: readonly IDepthPyramidLevel[];
}

/** The camera the pyramid was built from, which is the only camera the test reprojects into. */
export interface IOcclusionFrame {
  /** Column-major `projection * viewInverse` of the frame the pyramid came from. */
  readonly viewProjection: Float32Array;
  /** The frame's own drawing-buffer size, which is what level 0's texels are pixels of. */
  readonly width: number;
  readonly height: number;
  /** A teleport or a projection change: the test is skipped for the whole frame. */
  readonly cut: boolean;
  readonly near?: number;
}

/** The pyramid a cull tests against, and whether a hidden placement is dropped or only counted. */
export interface IKernelOcclusion {
  readonly frame: IOcclusionFrame;
  readonly pyramid: IDepthPyramid;
  /**
   * `false` measures: a placement the test hides is counted and still drawn, which is the point of
   * a measured frame — the picture is the unmeasured one and the count is the hypothesis. `true` is
   * the cull the next phase turns on by default.
   */
  readonly cull: boolean;
}

/**
 * The max-distance chain of a frame's own view-axis depths. Level 0 is the buffer handed in and
 * every level above it is the 2x2 maximum of the level below, clamped at the edge so an odd width
 * loses no texel to an out-of-range read.
 */
export function buildDepthPyramid(
  distance: Float32Array,
  width: number,
  height: number,
): IDepthPyramid {
  const levels: IDepthPyramidLevel[] = [{ width, height, distance }];
  let source = levels[0] as IDepthPyramidLevel;
  while (source.width > 1 || source.height > 1) {
    const next = reduceMax(source);
    levels.push(next);
    source = next;
  }
  return { levels };
}

/** One level up: the 2x2 maximum of `source`, clamped at the edge so an odd size keeps every texel. */
function reduceMax(source: IDepthPyramidLevel): IDepthPyramidLevel {
  const width = Math.max(1, Math.ceil(source.width / 2));
  const height = Math.max(1, Math.ceil(source.height / 2));
  const next: IDepthPyramidLevel = { width, height, distance: new Float32Array(width * height) };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let far = 0;
      for (const [dx, dy] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ] as const) {
        const sx = Math.min(source.width - 1, x * 2 + dx);
        const sy = Math.min(source.height - 1, y * 2 + dy);
        far = Math.max(far, source.distance[sy * source.width + sx] as number);
      }
      next.distance[y * width + x] = far;
    }
  }
  return next;
}

/**
 * Would this placement be hidden from the frame the pyramid came from?
 *
 * The sphere is reprojected into last frame's clip space, where `w` is its view-axis distance, and
 * its screen half-extent bounds both the numerator and perspective divide over the sphere.
 * Row lengths recover projection scale even after camera rotation. The level is the
 * one whose texels cover the footprint, and the answer is whether the sphere's
 * nearest point along the view axis is behind the farthest distance the four texels under it hold.
 */
export function occludedBy(
  occlusion: IKernelOcclusion,
  centre: ArrayLike<number>,
  radius: number,
): boolean {
  const { frame, pyramid } = occlusion;
  // A camera cut skips the test for the frame: the pyramid is a different camera's depth.
  if (frame.cut) return false;
  const levels = pyramid.levels;
  const base = levels[0] as IDepthPyramidLevel;
  const projected = projectInto(frame, centre, radius, base);
  if (projected === undefined) return false;
  const index = Math.min(
    levels.length - 1,
    Math.max(0, Math.ceil(Math.log2(projected.diameter(base)))),
  );
  const level = levels[index] as IDepthPyramidLevel;
  const far = footprintMax(
    level,
    base.width / 2 ** index,
    base.height / 2 ** index,
    projected.at,
    projected.row,
    projected.halfX,
    projected.halfY,
  );
  return projected.w - radius > far;
}

/** A sphere in the frame's clip space and the texels under it, or `undefined` when it is kept. */
interface IProjectedSphere {
  readonly w: number;
  readonly at: number;
  readonly row: number;
  readonly halfX: number;
  readonly halfY: number;
  /** The footprint's diameter in level-0 texels, which is what picks the level. */
  diameter(base: IDepthPyramidLevel): number;
}

/**
 * The sphere as last frame's camera saw it, or `undefined` for the two answers that are never
 * "hidden": a sphere reaching the near plane, and a sphere off screen last frame.
 */
function projectInto(
  frame: IOcclusionFrame,
  centre: ArrayLike<number>,
  radius: number,
  base: IDepthPyramidLevel,
): IProjectedSphere | undefined {
  const m = frame.viewProjection;
  const x = centre[0] as number;
  const y = centre[1] as number;
  const z = centre[2] as number;
  // `w` is the view-axis distance: a sphere reaching the near plane has no rect to compare.
  const w = (m[3] as number) * x + (m[7] as number) * y + (m[11] as number) * z + (m[15] as number);
  if (w - radius <= (frame.near ?? 0)) return undefined;
  const ndcX =
    ((m[0] as number) * x + (m[4] as number) * y + (m[8] as number) * z + (m[12] as number)) / w;
  const ndcY =
    ((m[1] as number) * x + (m[5] as number) * y + (m[9] as number) * z + (m[13] as number)) / w;
  // Expand one base texel for raster edges and the padded last texel of an odd-sized depth.
  const halfX =
    (radius * (Math.hypot(m[0] as number, m[4] as number, m[8] as number) + Math.abs(ndcX))) /
      (w - radius) +
    2 / base.width;
  const halfY =
    (radius * (Math.hypot(m[1] as number, m[5] as number, m[9] as number) + Math.abs(ndcY))) /
      (w - radius) +
    2 / base.height;
  if (Math.abs(ndcX) + halfX > 1 || Math.abs(ndcY) + halfY > 1) return undefined;
  return {
    diameter: (base) => Math.max(1, Math.max(halfX * base.width, halfY * base.height)),
    halfX,
    halfY,
    row: 0.5 - ndcY * 0.5,
    at: ndcX * 0.5 + 0.5,
    w,
  };
}

/**
 * The farthest distance the 2x2 texel block under a sphere's corner holds.
 *
 * The level is chosen so the sphere spans about one texel of it, so this block is the whole of the
 * sphere's last-frame footprint; the edge clamp is what an odd width costs.
 */
function footprintMax(
  level: IDepthPyramidLevel,
  spanX: number,
  spanY: number,
  at: number,
  row: number,
  halfX: number,
  halfY: number,
): number {
  const x = Math.max(0, Math.min(level.width - 1, Math.floor((at - halfX / 2) * spanX)));
  const y = Math.max(0, Math.min(level.height - 1, Math.floor((row - halfY / 2) * spanY)));
  let far = 0;
  for (let dy = 0; dy < 2; dy += 1) {
    for (let dx = 0; dx < 2; dx += 1) {
      const x2 = Math.min(level.width - 1, x + dx);
      const y2 = Math.min(level.height - 1, y + dy);
      far = Math.max(far, level.distance[y2 * level.width + x2] as number);
    }
  }
  return far;
}

/**
 * A TSL node this module reads through the swizzles and the `.element()` chain.
 *
 * Three's node types are precise about which swizzle a `vec4` answers and deliberately vague about
 * what a storage element or a texture load resolves to, and the pyramid is the one place in core
 * that has to read a matrix column and a loaded depth. The cast is confined here so the shader
 * reads as the plain thing it is.
 */
// quality-allow: the pyramid is a typed handle onto three's TSL nodes, which resolve to `any` in 0.185.
// biome-ignore lint/suspicious/noExplicitAny: three's TSL types refuse the chains these shaders read.
type Kernel = any;

/** A TSL value this module builds its shaders from. */
function nodes(value: unknown): Kernel {
  return value as Kernel;
}

/** Words of per-level table each level's row occupies, at the head of the pyramid's one buffer. */
const TABLE_WORDS = 4;

/** The 2x2 footprint every level of the chain reduces, in the order the loop walks it. */
const FOOTPRINT = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
] as const;

/**
 * The GPU half of the same rule: the buffers a level is written into, the per-level table the test
 * addresses them by, and one dispatch per level that reduces the level below — or the frame's own
 * depth texture, for level 0.
 *
 * Level 0 is half the depth's own resolution, so the chain starts one texel per four pixels. That
 * is the granularity this shape of cull always has: a sphere narrower than a texel cannot be
 * tested at all, and a finer level 0 would only lengthen the chain without rejecting more.
 */
/**
 * The GPU half of the same rule, and the whole pyramid in one storage buffer.
 *
 * One buffer and not two is a device limit, not a taste: the cull kernel already binds seven storage
 * buffers and WebGPU refuses a pipeline over eight per stage unless the device was asked for more —
 * measured on the RTX 2080 as `The number of storage buffers (9) in the Compute stage exceeds the
 * maximum per-stage limit (8)`. So the per-level table is the head of this one buffer, four words a
 * level, and the distances follow at each level's own offset.
 */
export class DepthPyramid {
  /** `[width, height, offset, 0]` per level, then every level's distances. */
  #words = new StorageBufferAttribute(new Float32Array(TABLE_WORDS), 1);
  /** The depth texture's own size, which level 0 reads its 2x2 footprint out of. */
  readonly #depthSize = uniform(new Vector2(1, 1));
  /** `(near, far)` of the frame the depth came from, which turn its NDC depth into metres. */
  readonly #nearFar = uniform(new Vector2(0.1, 1000));
  #levels: { width: number; height: number; offset: number }[] = [];
  #kernels: Kernel[] = [];
  #depth: DepthTexture | undefined;
  #samples = 1;
  #disposed = false;

  /** The chain's level count, which is also the clamp the test's level selection runs into. */
  get levels(): number {
    return this.#levels.length;
  }

  /** One storage binding for the table and the distances together, as the cull kernel reads it. */
  get chain(): Kernel {
    return nodes(storage(this.#words, "float", this.#words.count));
  }

  /**
   * Size the chain for a depth texture and write its per-level table.
   *
   * Structural: a resize replaces the buffer, so every level kernel is a new pipeline. A depth that
   * did not change size is left alone, because a frame never reallocates.
   */
  resize(depthWidth: number, depthHeight: number): boolean {
    const levels: { width: number; height: number; offset: number }[] = [];
    let span = 0;
    let width = Math.max(1, Math.ceil(depthWidth / 2));
    let height = Math.max(1, Math.ceil(depthHeight / 2));
    // Down to a single texel, and the loop condition is that texel rather than `width > 0`: a `1`
    // halved is `0` and floored back to `1`, so a positive-width test never ends.
    while (true) {
      levels.push({ width, height, offset: span });
      span += width * height;
      if (width === 1 && height === 1) break;
      width = Math.max(1, Math.ceil(width / 2));
      height = Math.max(1, Math.ceil(height / 2));
    }
    // The distances start after the table, whose width the loop above only now knows.
    for (const level of levels) level.offset += levels.length * TABLE_WORDS;
    const held = this.#levels;
    if (
      levels.length === held.length &&
      levels.every((level, index) => {
        const own = held[index];
        return own !== undefined && own.width === level.width && own.height === level.height;
      })
    )
      return false;
    this.#words = new StorageBufferAttribute(
      new Float32Array(levels.length * TABLE_WORDS + span),
      1,
    );
    const table = this.#words.array as Float32Array;
    for (const [index, level] of levels.entries()) {
      table[index * TABLE_WORDS] = level.width;
      table[index * TABLE_WORDS + 1] = level.height;
      table[index * TABLE_WORDS + 2] = level.offset;
    }
    this.#words.needsUpdate = true;
    this.#levels = levels;
    this.#kernels = [];
    return true;
  }

  /**
   * Resolve every sample of the previous frame's stored depth into level 0, then reduce the chain.
   * The resolve shares level 0's dispatch, so timing the whole chain includes that cost.
   */
  build(
    renderer: { compute(node: unknown, span?: "depthPyramid"): void },
    depth: DepthTexture,
    near: number,
    far: number,
    samples = 1,
  ): number {
    if (this.#disposed || this.#levels.length === 0) return 0;
    if (depth !== this.#depth || samples !== this.#samples) {
      this.#kernels = [];
      this.#depth = depth;
      this.#samples = samples;
    }
    this.#depthSize.value.set(depth.image.width ?? 0, depth.image.height ?? 0);
    this.#nearFar.value.set(near, far);
    // Three timestamps a compute group around all its dispatches, including level 0's depth resolve.
    for (const [index] of this.#levels.entries()) this.#levelKernel(index, depth);
    renderer.compute(this.#kernels, "depthPyramid");
    return this.#levels.length;
  }

  /**
   * One level's reduction, as its own pipeline with its own level baked in.
   *
   * The level is a constant rather than a uniform because a uniform written between two dispatches of
   * the same frame only re-uploads if the node happens to flush per dispatch, and a pyramid that
   * reduced the wrong level is still a pyramid. With the level constant the level it reads is a
   * constant too, so this shader carries no table reads at all.
   */
  #levelKernel(index: number, depth: DepthTexture): unknown {
    const held = this.#kernels[index];
    if (held !== undefined) return held;
    const own = this.#levels[index] as { width: number; height: number; offset: number };
    const below = this.#levels[index - 1];
    const chain = this.chain;
    const depthSize = nodes(this.#depthSize);
    const nearFar = nodes(this.#nearFar);
    const built = nodes(
      Fn(() => {
        // One thread per texel of this level, addressed as a float: TSL's clamp is float-only, so
        // the whole reduction stays in floats and converts once, at the storage index.
        const linear = float(instanceIndex);
        If(linear.greaterThanEqual(own.width * own.height), () => {
          Return();
        });
        const y = linear.div(own.width).floor();
        const x = linear.sub(y.mul(own.width));
        const far = float(0).toVar();
        for (const [dx, dy] of FOOTPRINT) {
          // Resolve the stored MSAA attachment into this single-distance buffer. Max over every
          // sample keeps an uncovered edge sample; copying depth or changing the main pass is unnecessary.
          for (
            let sampleIndex = 0;
            sampleIndex < (below === undefined ? this.#samples : 1);
            sampleIndex += 1
          ) {
            const sample =
              below === undefined
                ? nodes(nearFar.x)
                    .mul(nodes(nearFar.y))
                    .div(
                      nodes(nearFar.y).sub(
                        nodes(nearFar.y)
                          .sub(nodes(nearFar.x))
                          .mul(
                            textureLoad(
                              depth,
                              nodes(
                                ivec2(
                                  int(nodes(x.mul(2).add(dx)).clamp(0, nodes(depthSize.x).sub(1))),
                                  int(nodes(y.mul(2).add(dy)).clamp(0, nodes(depthSize.y).sub(1))),
                                ),
                              ),
                              float(sampleIndex),
                            ),
                          ),
                      ),
                    )
                : chain.element(
                    float(below.offset)
                      .add(
                        nodes(y.mul(2).add(dy))
                          .clamp(0, below.height - 1)
                          .mul(below.width),
                      )
                      .add(nodes(x.mul(2).add(dx)).clamp(0, below.width - 1)),
                  );
            far.assign(max(far, nodes(sample)));
          }
        }
        chain
          .element(
            float(own.offset)
              .add(nodes(y.mul(own.width)))
              .add(x),
          )
          .assign(far);
      })().compute(Math.max(1, own.width * own.height)),
    );
    built.name = `tnDepthPyramid${String(index)}`;
    this.#kernels[index] = built;
    return built;
  }

  /**
   * The test, in the cull kernel's own language: the same four keeps and the same comparison, read
   * off the same buffer {@link occludedBy} reads off its own arrays.
   *
   * `centre` is a TSL world position, `radius` its bounding-sphere radius, `viewProjection` the
   * previous frame's `projection * viewInverse` as a `mat4` uniform and `cut` this frame's cut flag.
   * Matrix row lengths recover projection scale without assuming an unrotated camera.
   *
   * The answer is a float, not a bool: `1` is hidden. A cull kernel runs the test once per part of a
   * placement's level and branches on the answer each time, and a float is what a TSL variable holds
   * across those branches without recomputing the test per part.
   */
  occluded(centre: Kernel, radius: Kernel, viewProjection: Kernel, cut: Kernel): Kernel {
    const chain = this.chain;
    const last = Math.max(0, this.levels - 1);
    const clip = viewProjection.mul(vec4(centre, 1));
    const w = clip.w;
    const depth = max(w, float(1e-6));
    const ndc = clip.xyz.div(depth);
    const nearest = max(w.sub(radius), float(1e-6));
    const scaleX = nodes(
      vec3(viewProjection.element(0).x, viewProjection.element(1).x, viewProjection.element(2).x),
    ).length();
    const scaleY = nodes(
      vec3(viewProjection.element(0).y, viewProjection.element(1).y, viewProjection.element(2).y),
    ).length();
    const halfX = nodes(scaleX.add(abs(ndc.x)))
      .mul(radius)
      .div(nearest)
      .add(float(2).div(chain.element(0)));
    const halfY = nodes(scaleY.add(abs(ndc.y)))
      .mul(radius)
      .div(nearest)
      .add(float(2).div(chain.element(1)));
    // The level a footprint this wide needs, and that level's own row of the table.
    const level = nodes(
      nodes(
        ceil(log2(max(float(1), max(halfX.mul(chain.element(0)), halfY.mul(chain.element(1)))))),
      ).clamp(0, last),
    ).toVar();
    const row = int(level.mul(TABLE_WORDS)).toVar();
    const width = chain.element(row);
    const height = chain.element(nodes(row).add(1));
    const spanX = nodes(chain.element(0)).div(pow(float(2), level));
    const spanY = nodes(chain.element(1)).div(pow(float(2), level));
    const far = float(0).toVar();
    for (const [dx, dy] of FOOTPRINT) {
      // The footprint spans about one texel of this level, so the 2x2 block under its corner is the
      // whole of it.
      const x = nodes(ndc.x.mul(0.5).add(0.5).sub(halfX.div(2)).mul(spanX))
        .floor()
        .add(dx)
        .clamp(0, nodes(width).sub(1));
      const y = nodes(float(0.5).sub(ndc.y.mul(0.5)).sub(halfY.div(2)).mul(spanY))
        .floor()
        .add(dy)
        .clamp(0, nodes(height).sub(1));
      far.assign(
        max(
          far,
          chain.element(
            nodes(chain.element(nodes(row).add(2)))
              .add(nodes(y).mul(width))
              .add(x),
          ),
        ),
      );
    }
    const keeps = w
      .sub(radius)
      .lessThanEqual(nodes(this.#nearFar).x)
      .or(ndc.x.abs().add(halfX).greaterThan(1))
      .or(ndc.y.abs().add(halfY).greaterThan(1))
      .or(cut.greaterThan(0.5));
    return keeps
      .not()
      .and(nodes(w.sub(radius)).greaterThan(far))
      .select(float(1), float(0));
  }

  dispose(): void {
    this.#disposed = true;
    this.#kernels = [];
    this.#levels = [];
    this.#depth = undefined;
  }
}
