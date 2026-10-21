import type { Mesh, Object3D } from "three";
import {
  Break,
  Fn,
  If,
  Loop,
  abs,
  cross,
  dot,
  float,
  floor,
  int,
  ivec2,
  max,
  min,
  smoothstep,
  texture,
  textureLoad,
  uniform,
  vec3,
  vec4,
} from "three/tsl";
import type { Node } from "three/webgpu";
import {
  type ITraceScene,
  type ITraceSceneReport,
  MATERIAL_TEXELS,
  NODE_TEXELS,
  TRACE_TEXTURE_WIDTH,
  TRIANGLE_TEXELS,
  packTraceScene,
} from "./scene-trace.js";

export interface ITracedReflectionsOptions {
  /** Which meshes a ray can hit. Default: every mesh under a visible parent chain. */
  readonly include?: (mesh: Mesh) => boolean;
  /** Surfaces rougher than this take no traced reflection. Unreal's `LumenMaxRoughnessToTrace`: 0.4. */
  readonly maxRoughnessToTrace?: number;
  /** The weight falls from 1 to 0 over this much roughness, ending at `maxRoughnessToTrace`: 0.1. */
  readonly roughnessFadeLength?: number;
  /** Most nodes one ray visits before it gives up and reports a miss. Default 192. */
  readonly maxSteps?: number;
  /** False silences the TN_TRACED_REFLECTIONS line, not the report. */
  readonly marker?: boolean;
}

/** One ray's answer, as nodes. Every field is meaningful only where `hit` is 1. */
export interface ITracedHit {
  /** 1 where the ray found a surface, else 0. */
  readonly hit: Node<"float">;
  /** Metres along the (unit) ray, or -1 on a miss. */
  readonly distance: Node<"float">;
  readonly position: Node<"vec3">;
  /** The interpolated vertex normal, flipped to face the ray. */
  readonly normal: Node<"vec3">;
  /** The hit triangle's index in the pack's leaf order. */
  readonly triangle: Node<"float">;
  /** The hit material's colour, roughness, emissive (times intensity) and metalness, from the pack's table. */
  readonly albedo: Node<"vec3">;
  readonly roughness: Node<"float">;
  readonly emissive: Node<"vec3">;
  readonly metalness: Node<"float">;
  /** The index into `TracedReflections.scene.materials`: a game that needs a map or a node looks the material up. */
  readonly material: Node<"float">;
}

export interface ITracedRay {
  readonly origin: Node<"vec3">;
  /** Unit length. */
  readonly direction: Node<"vec3">;
  /** Closest hit allowed, in metres. Default 0.001. */
  readonly near?: Node<"float"> | number;
  /** Farthest hit allowed, in metres. Default 1e4. */
  readonly far?: Node<"float"> | number;
  /**
   * Stop at the first surface found, which need not be the nearest: the answer for a shadow ray, which only asks
   * whether anything is in the way. `distance`, `position` and the material then describe that surface.
   */
  readonly anyHit?: boolean;
}

const DEFAULT_NEAR = 0.001;
const DEFAULT_FAR = 1e4;
/** A direction component below this is nudged to it, so the slab test never divides by zero. */
const TINY = 1e-8;
/** Determinant below which a ray counts as parallel to a triangle. */
const PARALLEL = 1e-9;

/**
 * Ray queries against the scene's triangles for reflections, in the engine's own TSL: the pack is float
 * textures and the walk is a loop, so the kernel needs no storage buffer and no WGSL of its own.
 *
 * Unreal's Lumen reflections trace what the screen cannot see through a software scene (mesh SDFs, or hardware
 * rays) for surfaces smoother than a roughness cut-off, and fall back to a cached radiance below it. This is
 * the scene half of that: `trace()` answers "what does this ray hit" and the material at the hit. How the hit
 * is lit, what a miss sees and how the result joins the frame stay in the game's `src/render/` code.
 */
export class TracedReflections {
  /** The packed triangles; `scene.materials[hit.material]` is the three material of a hit. */
  readonly scene: ITraceScene;
  readonly maxRoughnessToTrace: number;
  readonly roughnessFadeLength: number;
  readonly maxSteps: number;
  readonly #nodes: ReturnType<typeof texture>;
  readonly #triangles: ReturnType<typeof texture>;
  readonly #materials: ReturnType<typeof texture>;

  constructor(root: Object3D, options: ITracedReflectionsOptions = {}) {
    const maxRoughnessToTrace = options.maxRoughnessToTrace ?? 0.4;
    const roughnessFadeLength = options.roughnessFadeLength ?? 0.1;
    const maxSteps = options.maxSteps ?? 192;
    if (!(maxRoughnessToTrace > 0 && maxRoughnessToTrace <= 1))
      throw new RangeError("TN_TRACED_REFLECTIONS: maxRoughnessToTrace must be in (0, 1]");
    if (!(roughnessFadeLength >= 0 && roughnessFadeLength <= maxRoughnessToTrace))
      throw new RangeError(
        "TN_TRACED_REFLECTIONS: roughnessFadeLength must be in [0, maxRoughnessToTrace]",
      );
    if (!(Number.isInteger(maxSteps) && maxSteps > 0))
      throw new RangeError("TN_TRACED_REFLECTIONS: maxSteps must be a positive whole number");
    this.maxRoughnessToTrace = maxRoughnessToTrace;
    this.roughnessFadeLength = roughnessFadeLength;
    this.maxSteps = maxSteps;
    this.scene = packTraceScene(
      root,
      options.include === undefined ? {} : { include: options.include },
    );
    this.#nodes = texture(this.scene.nodes);
    this.#triangles = texture(this.scene.triangles);
    this.#materials = texture(this.scene.materialTable);
    if (options.marker !== false)
      console.info(`TN_TRACED_REFLECTIONS ${JSON.stringify(this.report)}`);
  }

  get report(): ITraceSceneReport & { readonly bytes: number } {
    const { nodes, triangles, materialTable, report } = this.scene;
    const bytes = [nodes, triangles, materialTable].reduce(
      (sum, t) => sum + t.image.width * t.image.height * 16,
      0,
    );
    return { ...report, bytes };
  }

  /**
   * 1 for a surface at least as smooth as the cut-off minus the fade, falling to 0 at `maxRoughnessToTrace`.
   * Multiply a traced reflection by it so a rough surface never shows a trace's noise.
   */
  weight(roughness: Node<"float">): Node<"float"> {
    return float(1).sub(
      smoothstep(
        this.maxRoughnessToTrace - this.roughnessFadeLength,
        this.maxRoughnessToTrace,
        roughness,
      ),
    );
  }

  /** `weight` for one roughness on the CPU: a surface rougher than `maxRoughnessToTrace` casts no ray. */
  weightAt(roughness: number): number {
    const edge = this.maxRoughnessToTrace - this.roughnessFadeLength;
    const t = Math.min(1, Math.max(0, (roughness - edge) / (this.roughnessFadeLength || 1)));
    return roughness >= this.maxRoughnessToTrace ? 0 : 1 - t * t * (3 - 2 * t);
  }

  /** The texel at `index` of a row-major pack texture, `TRACE_TEXTURE_WIDTH` wide. */
  #fetch(source: ReturnType<typeof texture>, index: Node<"float">): Node<"vec4"> {
    const row = floor(index.div(TRACE_TEXTURE_WIDTH));
    const column = index.sub(row.mul(TRACE_TEXTURE_WIDTH));
    return textureLoad(source, ivec2(int(column), int(row)));
  }

  /**
   * The nearest surface along a ray, with its normal and material. The walk is the depth-first, skip-pointer one
   * `traceScene` runs on the CPU: a node's box is tested, a miss jumps to the node after the subtree, a hit on an
   * inner node steps to its left child, a leaf tests its triangles in a loop.
   */
  trace(ray: ITracedRay): ITracedHit {
    const near =
      typeof ray.near === "number" || ray.near === undefined
        ? float(ray.near ?? DEFAULT_NEAR)
        : ray.near;
    const far =
      typeof ray.far === "number" || ray.far === undefined
        ? float(ray.far ?? DEFAULT_FAR)
        : ray.far;
    const fetchNode = (index: Node<"float">) => this.#fetch(this.#nodes, index);
    const fetchTriangle = (index: Node<"float">) => this.#fetch(this.#triangles, index);
    const fetchMaterial = (index: Node<"float">) => this.#fetch(this.#materials, index);
    // A runtime trip count, so a driver's compiler cannot unroll the walk into a program too large to compile.
    const steps = uniform(this.maxSteps);
    const walk = Fn(
      ([origin, direction, nearT, farT]: [
        Node<"vec3">,
        Node<"vec3">,
        Node<"float">,
        Node<"float">,
      ]) => {
        // Zero is a valid direction component: nudge it so 1 / d stays finite, as the CPU walk does.
        const safe = vec3(
          direction.x.abs().lessThan(TINY).select(float(TINY), direction.x),
          direction.y.abs().lessThan(TINY).select(float(TINY), direction.y),
          direction.z.abs().lessThan(TINY).select(float(TINY), direction.z),
        );
        const inverse = vec3(1).div(safe);
        const best = farT.toVar();
        const found = float(-1).toVar();
        const foundU = float(0).toVar();
        const foundV = float(0).toVar();
        const node = float(0).toVar();
        Loop({ start: int(0), end: int(steps), type: "int", condition: "<" }, () => {
          If(node.lessThan(0), () => {
            Break();
          });
          const low = fetchNode(node.mul(NODE_TEXELS));
          const high = fetchNode(node.mul(NODE_TEXELS).add(1));
          const t0 = low.xyz.sub(origin).mul(inverse);
          const t1 = high.xyz.sub(origin).mul(inverse);
          const enter = max(max(min(t0.x, t1.x), min(t0.y, t1.y)), max(min(t0.z, t1.z), nearT));
          const leave = min(min(max(t0.x, t1.x), max(t0.y, t1.y)), min(max(t0.z, t1.z), best));
          If(leave.lessThan(enter), () => {
            node.assign(low.w);
          }).Else(() => {
            If(high.w.lessThan(0), () => {
              node.addAssign(1);
            }).Else(() => {
              const first = floor(high.w.div(16));
              const count = high.w.sub(first.mul(16));
              Loop({ start: int(0), end: int(count), type: "int", condition: "<" }, ({ i }) => {
                const index = first.add(float(i));
                const base = index.mul(TRIANGLE_TEXELS);
                const a = fetchTriangle(base);
                const b = fetchTriangle(base.add(1));
                const c = fetchTriangle(base.add(2));
                const edge1 = b.xyz.sub(a.xyz);
                const edge2 = c.xyz.sub(a.xyz);
                // Moller-Trumbore. A positive determinant is a hit on the front face.
                const p = cross(safe, edge2);
                const det = dot(edge1, p);
                const side = b.w;
                const facing = side
                  .greaterThan(1.5)
                  .select(
                    abs(det).greaterThan(PARALLEL),
                    side.lessThan(0.5).select(det.greaterThan(PARALLEL), det.lessThan(-PARALLEL)),
                  );
                If(facing, () => {
                  const inverseDet = float(1).div(det);
                  const s = origin.sub(a.xyz);
                  const u = dot(s, p).mul(inverseDet);
                  const q = cross(s, edge1);
                  const v = dot(safe, q).mul(inverseDet);
                  const t = dot(edge2, q).mul(inverseDet);
                  If(
                    u
                      .greaterThanEqual(0)
                      .and(u.lessThanEqual(1))
                      .and(v.greaterThanEqual(0))
                      .and(u.add(v).lessThanEqual(1))
                      .and(t.greaterThan(nearT))
                      .and(t.lessThan(best)),
                    () => {
                      best.assign(t);
                      found.assign(index);
                      foundU.assign(u);
                      foundV.assign(v);
                    },
                  );
                });
              });
              // A shadow ray ends with its first hit: jump past the end of the tree.
              node.assign(
                ray.anyHit === true ? found.greaterThanEqual(0).select(float(-1), low.w) : low.w,
              );
            });
          });
        });
        return vec4(best, foundU, foundV, found);
      },
    );
    const result = walk(ray.origin, ray.direction, near, far);
    const triangle = result.w;
    const hit = triangle.greaterThanEqual(0).select(float(1), float(0));
    // A miss reads triangle 0 (a valid texel) and is discarded by `hit`.
    const base = max(triangle, float(0)).mul(TRIANGLE_TEXELS);
    const corner = fetchTriangle(base);
    const weights = vec3(float(1).sub(result.y).sub(result.z), result.y, result.z);
    const normalA = fetchTriangle(base.add(3)).xyz;
    const normalB = fetchTriangle(base.add(4)).xyz;
    const normalC = fetchTriangle(base.add(5)).xyz;
    const interpolated = normalA
      .mul(weights.x)
      .add(normalB.mul(weights.y))
      .add(normalC.mul(weights.z));
    const lengthSquared = max(dot(interpolated, interpolated), float(1e-12));
    const unit = interpolated.div(lengthSquared.sqrt());
    const normal = dot(unit, ray.direction).greaterThan(0).select(unit.negate(), unit);
    const material = corner.w;
    const albedo = fetchMaterial(material.mul(MATERIAL_TEXELS));
    const emission = fetchMaterial(material.mul(MATERIAL_TEXELS).add(1));
    return {
      hit,
      distance: hit.greaterThan(0).select(result.x, float(-1)),
      position: ray.origin.add(ray.direction.mul(result.x)),
      normal,
      triangle,
      albedo: albedo.xyz,
      roughness: albedo.w,
      emissive: emission.xyz,
      metalness: emission.w,
      material,
    };
  }

  dispose(): void {
    this.scene.dispose();
  }
}
